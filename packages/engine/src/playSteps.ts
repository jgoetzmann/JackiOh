// SPEC §10.5 "Playing a card": the eight steps, in order, as named steps that other code can run
// and that a prompt can pause in the middle of (BUILD M3-T2/T3, R81, R90).
//
// The pipeline is one table of named steps (`PLAY_STEPS`) driven by `drive`, and every step reads
// and writes the same plain record — a `PlayRun`, which is JSON. That is what makes the sequence
// resumable: when a step leaves a prompt open, the rest of the pipeline is owed to `state.work` as
// a `Resume` naming the step to pick up at plus that record (§9.3 "mid-action choices are state,
// not callbacks"), and the resolution loop drains it after the answer. Nothing is ever held across
// a prompt in a local variable or a closure, which is the bug `work.ts` exists to prevent.
//
// So a Cry that opens a prompt resumes into the *remaining* steps rather than restarting: the
// answer re-enters the card's own step, `settle` then runs what the pipeline owed, and steps 6, 7
// and 8 finish the play. Echo (R30) is the same machinery pointed at itself — step 6 is re-entrant,
// takes one repeat at a time off `state.echoQueue` and re-runs step 5 with *fresh* prompts, so a
// prompt inside one repeat leaves the rest waiting in state (§6.1 "Echo X").
//
// Three steps keep their own cursor inside the record, so a pause inside one continues where it
// stopped instead of at the top: step 3 over the `onPlayHook` holders, step 5 over its named parts,
// step 6 over the echo queue and the repeat's fresh picks.
//
// What is *not* here: which choices are legal (that is `playChoices.ts`, R90), what a cost is
// (`mana.ts`, R65), what a card's text does (the card's script, which is a pure builder the engine
// applies — CLAUDE.md rule 5) and R43's power mechanics (`subsystems/heroPower.ts`).

import type { ActionBody, PlayerId, Selection } from "@jackioh/shared";
import { opponentOf } from "@jackioh/shared";
import { defOf } from "./catalog";
import { dealDamage } from "./damage";
import { draw } from "./draw";
import {
  CAST_TAIL_WORK,
  castTailOf,
  landAfterResolution,
  queueEchoRepeats,
  takeEchoRepeat,
} from "./echo";
import { sacrifice } from "./effects";
import { effectiveCost, isXCost, manaEvent, modifierIsLive, spendMana } from "./mana";
import { removeModifier } from "./modifiers";
import {
  declaredModes,
  declaredTargets,
  legalSelectionsFor,
  playsOnStack,
  whyChoicesRefused,
} from "./playChoices";
import {
  closePrompt,
  openPrompt,
  resumeOf,
  runHookResumable,
  whyAnswerRefused,
  type AnswerInput,
} from "./prompts";
import {
  applyEffects,
  flagReturnToHandAtEndOfTurn,
  makeContext,
  type EngineSink,
} from "./resolve";
import {
  findInstance,
  type CardInstance,
  type GameState,
  type Resume,
  type WorkItem,
} from "./state";
import { settle } from "./triggers";
import { triggerHoldersWithHook } from "./triggers";
import { dropWork, paused, pausedOf, pushWork, registerWorkHandler } from "./work";
import { firstFreeZone, placeOnField, type ZoneSlot } from "./zones";

export type PlayAction = Extract<ActionBody, { type: "play" }>;

/** The eight steps of §10.5, in the order that section lists them. */
export const PLAY_STEPS = [
  "validate",
  "pay",
  "giftedHook",
  "place",
  "resolve",
  "echo",
  "finish",
  "settle",
] as const;

export type PlayStepName = (typeof PLAY_STEPS)[number];

/** The named parts of step 5, so a pause inside one continues at the next, never at the top. */
export const RESOLVE_PARTS = ["quickstriker", "comboDraw", "script"] as const;

export type ResolvePart = (typeof RESOLVE_PARTS)[number];

/** `resume.hook` for an owed play pipeline: the sequence name `work.ts` documents (`"play"`). */
export const PLAY_WORK_KIND = "play";

/** Where the run record sits inside `resume.data`, so the rest of `data` stays the card's own. */
const RUN_KEY = "__play";

/**
 * A play part-way through its steps. All JSON: it is stored inside an owed `WorkItem`'s
 * `resume.data` and inside the `resume` of a prompt the pipeline opened itself, so a paused play
 * survives `JSON.parse(JSON.stringify(state))` and a replay resumes it exactly (§9.3, §10.1).
 */
export type PlayRun = {
  instanceId: string;
  defId: string;
  player: PlayerId;
  /** The mana actually paid, which `cardPlayed` reports and Gifted Program reads (§8 #64). */
  costPaid: number;
  /** Where a permanent goes; null for a Spell, which resolves instead (§10.5 step 4). */
  zone: ZoneSlot | null;
  targets: Selection[];
  modes: string[];
  tributes: string[];
  /** Index into `PLAY_STEPS` of the step to run next. */
  at: number;
  /** Step 3's cursor: how many `onPlayHook` holders have run. */
  hookAt: number;
  /** Step 5's cursor into `RESOLVE_PARTS`. */
  resolveAt: number;
  /** Step 6: whether this play has worked out how many repeats it owes yet. */
  echoQueued: boolean;
  /** Step 6: the repeat being re-resolved, with the fresh answers collected so far. */
  repeat: null | { targets: Selection[]; modes: string[]; declAt: number; modeAt: number };
  /** Set while a prompt this pipeline opened is waiting; says which bucket the answer fills. */
  awaiting: null | "echoTarget" | "echoMode";
};

// ---------------------------------------------------------------------------
// The owed record
// ---------------------------------------------------------------------------

function resumeFor(run: PlayRun, at: number): Resume {
  return {
    defId: run.defId,
    hook: PLAY_WORK_KIND,
    step: PLAY_STEPS[at] ?? "settle",
    radiant: false,
    instanceId: run.instanceId,
    data: { [RUN_KEY]: { ...run, at } },
  };
}

/** True when this continuation is an owed play pipeline rather than a card's own step. */
export function isPlayResume(resume: { hook: string }): boolean {
  return resume.hook === PLAY_WORK_KIND;
}

/** The run record a continuation carries, or null when it is not one of ours. */
export function runOf(resume: { data: Record<string, unknown> }): PlayRun | null {
  const raw = resume.data[RUN_KEY];
  if (raw === null || typeof raw !== "object") return null;
  const run = raw as Partial<PlayRun>;
  if (typeof run.instanceId !== "string" || typeof run.at !== "number") return null;
  return raw as PlayRun;
}

// ---------------------------------------------------------------------------
// Step 1 — validate (§10.5 step 1)
// ---------------------------------------------------------------------------

function handCard(state: GameState, player: PlayerId, instanceId: string): CardInstance | undefined {
  return state.players[player].hand.find((card) => card.id === instanceId);
}

export function isPermanent(state: GameState, card: CardInstance): boolean {
  return defOf(state, card.defId).type !== "Spell";
}

/**
 * §10.5 step 1: "legal zone, cost ≤ current mana after all modifiers, Tribute available, X or
 * embiggen chosen, targets legal — every choice the play carried is checked against what the card
 * declared and what the board allows (R90)". Every one of those checks is `playChoices.ts`'s, which
 * is why this asks once and restates nothing; what is left here is the cost, which `mana.ts` owns,
 * and the default zone a play that named none takes (R64's leftmost free zone).
 *
 * X and embiggen are stamped on the instance before the cost is read, because that is where R65's
 * calculation looks for them. `reduce` clones the state and throws the clone away on a refusal, so
 * a refused play leaves nothing behind (§9.3).
 */
export function validatePlay(
  sink: EngineSink,
  player: PlayerId,
  action: PlayAction,
): { error: string } | { run: PlayRun } {
  const state = sink.state;
  const card = handCard(state, player, action.instanceId);
  if (card === undefined) return { error: `no card ${action.instanceId} in ${player}'s hand` };

  const refused = whyChoicesRefused(state, player, card, action);
  if (refused !== null) return { error: refused };

  if (isXCost(state, card)) card.x = action.x ?? 0;
  if (typeof defOf(state, card.defId).cost === "object") card.embiggened = action.embiggen === true;

  const cost = effectiveCost(state, card);
  if (cost > state.players[player].mana.current) {
    return { error: `${defOf(state, card.defId).name} costs ${cost}, more than your mana` };
  }

  // Step 1 accepted the zone; a play that named none takes the leftmost free one.
  let zone: ZoneSlot | null = null;
  if (isPermanent(state, card)) {
    const named = action.zone;
    zone =
      named === undefined
        ? firstFreeZone(state, player, defOf(state, card.defId).type === "Unit" ? "units" : "backrow")
        : { player, row: named.row, lane: named.lane };
    if (zone === null) return { error: "no free zone" };
  }

  return {
    run: {
      instanceId: card.id,
      defId: card.defId,
      player,
      costPaid: cost,
      zone,
      targets: [...(action.targets ?? [])],
      modes: [...(action.modes ?? [])],
      tributes: [...(action.tributes ?? [])],
      at: 1,
      hookAt: 0,
      resolveAt: 0,
      echoQueued: false,
      repeat: null,
      awaiting: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Step 2 — pay (§10.5 step 2)
// ---------------------------------------------------------------------------

/**
 * §6.3 Tribute: sacrifice the units this play named. How many they must be worth, whether an enemy
 * unit counts (#55) and that a Sheep Token counts 2 were all settled in step 1, so this is the
 * payment and nothing else — which is why it sacrifices what it was given (R41's backrow meal
 * included) rather than judging it again.
 */
function payTributes(sink: EngineSink, run: PlayRun, card: CardInstance): void {
  if (run.tributes.length === 0) return;
  const picks: Selection[] = run.tributes.map((id) => ({ pick: "instance", instanceId: id }));
  const ctx = makeContext(sink, card, { controller: run.player, targets: picks });
  applyEffects(
    picks.map((_, index) => sacrifice({ target: { of: "chosen", index }, allowEnemy: true })),
    ctx,
  );
}

/**
 * §10.5 step 2: "consume the next-spell discount if used". A one-shot discount (Lunar Eclipse) is
 * `{ until: "used" }`, so the play it applied to spends it; an X-cost card ignores discounts and so
 * spends none (R65), and Professor Curvature's is not a one-shot but a next-turn modifier (R48).
 */
function consumeUsedDiscounts(sink: EngineSink, run: PlayRun, card: CardInstance): void {
  const state = sink.state;
  if (isXCost(state, card)) return;
  const type = defOf(state, card.defId).type;
  for (const mod of [...state.players[run.player].mods]) {
    if (mod.kind !== "costDiscount") continue;
    // §2.2 names the Lunar Eclipse discount as both "consumed on use" AND expired at cleanup, so
    // it cannot be expressed by the expiry alone: `{ until: "used" }` survives cleanup (that is
    // what keeps #79 Twinspell's `echoNextSpell` alive, R30), while `{ until: "thisTurn" }` is
    // never consumed here. `oncePerTurn` is the flag for exactly that pair — the card keeps the
    // "this turn" expiry and this consumes it on the first matching play (§8 row 35).
    if (mod.expiry.until !== "used" && mod.oncePerTurn !== true) continue;
    if (!modifierIsLive(state, mod)) continue;
    if (mod.onlyType !== undefined && mod.onlyType !== type) continue;
    removeModifier(sink, run.player, mod.id);
  }
}

function payStep(sink: EngineSink, run: PlayRun): void {
  const card = findInstance(sink.state, run.instanceId);
  if (card === undefined) return;
  const side = sink.state.players[run.player];

  spendMana(side, run.costPaid);
  sink.events.push(manaEvent(run.player, side));
  payTributes(sink, run, card);
  consumeUsedDiscounts(sink, run, card);
}

// ---------------------------------------------------------------------------
// Step 3 — the Gifted Program hook (§10.5 step 3)
// ---------------------------------------------------------------------------

/**
 * §10.5 step 3: "the Gifted Program hook may set `radiant` now". Every `onPlayHook` on the board
 * runs in R68's order, before the card is moved and before anything resolves, with the played card
 * as its selection and the cost paid in `data` (§8 #64 "Pre-resolution hook; cost = cost paid;
 * per-turn flag"). The cursor is advanced before each hook runs, so a hook that opens a prompt
 * continues with the hooks after it instead of running any of them twice.
 */
function giftedHookStep(sink: EngineSink, run: PlayRun): void {
  const holders = triggerHoldersWithHook(sink.state, "onPlayHook");
  for (let at = run.hookAt; at < holders.length; at += 1) {
    run.hookAt = at + 1;
    const holder = holders[at];
    if (holder === undefined) continue;
    runHookResumable(sink, holder.card, "onPlayHook", {
      controller: holder.controller,
      targets: [{ pick: "instance", instanceId: run.instanceId }],
      data: { playedId: run.instanceId, playedBy: run.player, costPaid: run.costPaid },
    });
    if (paused(sink)) return;
  }
}

// ---------------------------------------------------------------------------
// Step 4 — move the card and announce the play (§10.5 step 4)
// ---------------------------------------------------------------------------

function playedEvents(sink: EngineSink, run: PlayRun, card: CardInstance): void {
  sink.events.push({
    type: "cardPlayed",
    player: run.player,
    instanceId: card.id,
    defId: card.defId,
    costPaid: run.costPaid,
    ...(card.x === undefined ? {} : { x: card.x }),
    ...(card.embiggened === undefined ? {} : { embiggened: card.embiggened }),
  });
  if (run.zone !== null) {
    sink.events.push({
      type: "summoned",
      player: run.player,
      instanceId: card.id,
      defId: card.defId,
      row: run.zone.row,
      lane: run.zone.lane,
    });
  }
}

/**
 * §10.5 step 4: the card leaves the hand for the field (Units, Field Spells, Traps) or for the
 * resolving state (Spells); `cardPlayed` goes out; `turnLog.cardsPlayed` and the game's `played`
 * counter go up (R55); "Sheepish fires here for Units".
 *
 * That last clause is why this step ends in the resolution loop: the trap answers the play event
 * and resolves before step 5 runs the Cry, which is R17's "fires before the Cry (Cry lost)". It
 * also means the play's own events are never left owed while a prompt is open.
 */
function placeStep(sink: EngineSink, run: PlayRun): void {
  const state = sink.state;
  const card = findInstance(state, run.instanceId);
  if (card === undefined) return;
  const side = state.players[run.player];

  const at = side.hand.findIndex((held) => held.id === card.id);
  if (at >= 0) side.hand.splice(at, 1);

  if (run.zone !== null) {
    // §3.2/§6.2 Stack: step 1 already accepted an occupied unit zone for a Stack card, so the
    // placement is the one that builds the pile — the arriving card goes on top and the card
    // beneath stops acting (R13). Every other card needs the zone empty, which is what `stack:
    // false` keeps `placeOnField` insisting on.
    placeOnField(state, card, run.zone, { stack: playsOnStack(state, card) });
    card.summonedTurn = state.turn;
  } else {
    card.zone = { z: "resolving", player: run.player };
    side.resolving.push(card);
  }

  side.turnLog.playedIds.push(card.id);
  side.turnLog.cardsPlayed += 1;
  state.counters.played += 1;

  playedEvents(sink, run, card);
  settle(sink);
}

// ---------------------------------------------------------------------------
// Step 5 — resolve the card (§10.5 step 5)
// ---------------------------------------------------------------------------

/** §6.2 Combo X: "cards you played earlier this turn", so the card being played does not count. */
export function playedEarlierThisTurn(state: GameState, player: PlayerId): number {
  return Math.max(0, state.players[player].turnLog.cardsPlayed - 1);
}

/**
 * The card as step 4 left it, or null when it is no longer there to resolve: Sheepish transformed
 * it, a trap countered it, or it has ceased to exist (R11's `{ z: "gone" }`). R17: the Cry is lost.
 */
function stillResolving(state: GameState, run: PlayRun): CardInstance | null {
  const card = findInstance(state, run.instanceId);
  if (card === undefined || card.defId !== run.defId) return null;
  const zone = card.zone.z;
  return zone === "field" || zone === "resolving" ? card : null;
}

/**
 * #38 Quickstriker: "your cards gain 'Combo X: deal X damage to the enemy hero', X = cards you
 * played earlier this turn". The modifier says the Field Spell is out; the count says how much.
 */
function quickstrikerCombo(sink: EngineSink, run: PlayRun, card: CardInstance): void {
  const state = sink.state;
  const amount = playedEarlierThisTurn(state, run.player);
  if (amount <= 0) return;
  for (const mod of state.players[run.player].mods) {
    if (mod.kind !== "quickstrikerDamage" || !modifierIsLive(state, mod)) continue;
    dealDamage(sink, {
      source: card,
      target: { kind: "hero", player: opponentOf(run.player) },
      amount,
    });
  }
}

/** #78 /fullsend: "this turn your cards gain 'Combo: draw 1'" — a Combo with no X is Combo 1 (§6.2). */
function comboDrawStep(sink: EngineSink, run: PlayRun): void {
  const state = sink.state;
  if (playedEarlierThisTurn(state, run.player) < 1) return;
  for (const mod of [...state.players[run.player].mods]) {
    if (mod.kind !== "comboDraw" || !modifierIsLive(state, mod)) continue;
    draw(sink, run.player, Math.max(0, mod.amount));
  }
}

/**
 * §10.5 step 5: "Resolve Combo checks, Quickstriker, /fullsend's Combo draw, then the card's own
 * Cry or spell script (targets already chosen)". An ordinary card's own Combo check is part of its
 * own script, which reads `playedEarlierThisTurn`; what the engine owes is the two Combo abilities
 * another permanent grants everything you play, and they come first.
 */
function resolveStep(sink: EngineSink, run: PlayRun): void {
  for (let at = run.resolveAt; at < RESOLVE_PARTS.length; at += 1) {
    run.resolveAt = at + 1;
    const card = stillResolving(sink.state, run);
    if (card === null) return;

    switch (RESOLVE_PARTS[at]) {
      case "quickstriker":
        quickstrikerCombo(sink, run, card);
        break;
      case "comboDraw":
        comboDrawStep(sink, run);
        break;
      case "script":
        runHookResumable(sink, card, "cry", {
          controller: run.player,
          targets: run.targets,
          modes: run.modes,
        });
        break;
      default:
        break;
    }

    if (paused(sink)) return;
  }
}

// ---------------------------------------------------------------------------
// Step 6 — Echo (§10.5 step 6, R30)
// ---------------------------------------------------------------------------

function labelOf(selection: Selection): string {
  switch (selection.pick) {
    case "instance":
      return selection.instanceId;
    case "hero":
      return `${selection.player}'s hero`;
    case "zone":
      return `${selection.player} ${selection.row} ${selection.lane}`;
    case "mode":
      return selection.option;
    default:
      return "nothing";
  }
}

/**
 * R81: a card's play choices travel in the `play` action *once*. A repeat therefore asks again, as
 * prompts — §10.6's "an Echo repeat of Glowy Jelly Bean reopens its hand pick" — so each
 * declaration the card made is offered in turn and the answers collect in the repeat record. The
 * prompt carries the run record, so answering it re-enters this pipeline (see `answerPlayPrompt`).
 *
 * Returns true when every declaration has its answer and the repeat can resolve. A declaration the
 * board cannot satisfy is skipped rather than refused: the effect fizzles (R90, §8's conventions).
 */
function askRepeatChoices(sink: EngineSink, run: PlayRun, card: CardInstance): boolean {
  const repeat = run.repeat;
  if (repeat === null) return false;
  const name = defOf(sink.state, card.defId).name;

  const targets = declaredTargets(card);
  for (let at = repeat.declAt; at < targets.length; at += 1) {
    repeat.declAt = at + 1;
    const decl = targets[at];
    if (decl === undefined) continue;
    const options = legalSelectionsFor(sink.state, run.player, card, decl);
    if (options.length === 0) continue;
    run.awaiting = "echoTarget";
    const opened = openPrompt(sink, {
      player: run.player,
      kind: decl.kind,
      prompt: `Echo: ${name}`,
      options: options.map((selection) => ({
        key: `${selection.pick}:${labelOf(selection)}`,
        label: labelOf(selection),
        selection,
      })),
      min: decl.min,
      max: decl.max,
      resume: resumeFor(run, PLAY_STEPS.indexOf("echo")),
    });
    if (opened !== null) return false;
    run.awaiting = null;
  }

  const modes = declaredModes(card);
  for (let at = repeat.modeAt; at < modes.length; at += 1) {
    repeat.modeAt = at + 1;
    const decl = modes[at];
    if (decl === undefined || decl.options.length === 0) continue;
    run.awaiting = "echoMode";
    const opened = openPrompt(sink, {
      player: run.player,
      kind: decl.kind,
      prompt: `Echo: ${name}`,
      options: decl.options.map((option) => ({
        key: `mode:${option}`,
        label: option,
        selection: { pick: "mode", option },
      })),
      resume: resumeFor(run, PLAY_STEPS.indexOf("echo")),
    });
    if (opened !== null) return false;
    run.awaiting = null;
  }

  return true;
}

/**
 * §10.5 step 6: "Echo: repeat step 5 with fresh prompts N times". The repeats outstanding live in
 * `state.echoQueue` and resolve one at a time, so a prompt inside one pauses the rest (§6.1). This
 * is the step an owed pipeline re-enters, and it picks up from whatever the queue and the current
 * repeat record say, which is why it can be entered any number of times.
 */
function echoStep(sink: EngineSink, run: PlayRun): void {
  const opening = stillResolving(sink.state, run);
  if (opening === null) return;
  if (!run.echoQueued) {
    // Once per resolution: `queueEchoRepeats` consumes R30's grant (`echo.ts`).
    run.echoQueued = true;
    queueEchoRepeats(sink, opening, run.player);
  }

  for (;;) {
    const card = stillResolving(sink.state, run);
    if (card === null) return;

    if (run.repeat === null) {
      if (!takeEchoRepeat(sink.state, run.instanceId)) return;
      run.repeat = { targets: [], modes: [], declAt: 0, modeAt: 0 };
    }

    if (!askRepeatChoices(sink, run, card)) return;

    const repeat = run.repeat;
    run.repeat = null;
    runHookResumable(sink, card, "cry", {
      controller: run.player,
      targets: repeat?.targets ?? [],
      modes: repeat?.modes ?? [],
    });
    if (paused(sink)) return;
  }
}

// ---------------------------------------------------------------------------
// Step 7 — where a Spell lands (§10.5 step 7)
// ---------------------------------------------------------------------------

/**
 * §10.5 step 7, which `echo.ts` owns because a cast lands the same way (R70): the card reaches the
 * graveyard and `cardResolved` goes out — once per play, here, after step 6 has drained every Echo
 * repeat, which is the moment R17 gives Bear Honeypot, Unstable Clone Machine and Unlicensed
 * Experimentation.
 *
 * R155: this is also where §5.1's `returnToHandAtEndOfTurn` is written, because this is the step
 * §5.1 describes — the Spell has just reached the graveyard, and only a card that got there this
 * way returns from it at the end of the turn. `resolve.flagReturnToHandAtEndOfTurn` holds the three
 * conditions; it runs after the landing because "reached the graveyard" is one of them, and it is a
 * no-op for everything else the step lands — a permanent, and a Spell that exiled itself (#39).
 */
function finishStep(sink: EngineSink, run: PlayRun): void {
  landAfterResolution(sink, {
    instanceId: run.instanceId,
    defId: run.defId,
    player: run.player,
    // The same number step 4's `cardPlayed` reported: `run.costPaid` is the mana step 2 actually
    // charged, after every modifier and with R65's X and embiggen prices in it. A cast's tail
    // carries 0 (R70), which `runOwedCastTail` puts on the run it drives.
    costPaid: run.costPaid,
  });
  flagReturnToHandAtEndOfTurn(sink.state, run.instanceId);
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

type Step = {
  name: PlayStepName;
  run: (sink: EngineSink, run: PlayRun) => void;
  /** A step that is re-entered at itself, because it holds its own place in state. */
  repeats?: boolean;
};

/** Steps 2 to 8 of §10.5; step 1 runs before any of them and cannot pause. */
const STEP_TABLE: readonly Step[] = [
  { name: "validate", run: () => {} },
  { name: "pay", run: payStep },
  { name: "giftedHook", run: giftedHookStep, repeats: true },
  { name: "place", run: placeStep },
  { name: "resolve", run: resolveStep, repeats: true },
  { name: "echo", run: echoStep, repeats: true },
  { name: "finish", run: finishStep },
  { name: "settle", run: (sink) => settle(sink) },
];

/**
 * Run the steps from `run.at` on, and stop the moment one leaves a prompt open.
 *
 * The rest of the pipeline is owed to `state.work` *only when a step actually pauses*, never
 * before — R117, which this file used to get wrong. Two reasons, and the first is that bug:
 *
 *  - While `drive` is on the stack the steps are the driver's, so nothing else may run them.
 *    Step 4 ends in the resolution loop (`placeStep`), and `settle` drains `state.work` before it
 *    pops a trigger — so a pipeline that had parked itself in advance was drained by its own
 *    nested `settle`, which ran steps 5 to 8 (the Cry included) and then handed control back to a
 *    loop that ran them again. Owing the rest only at a pause keeps one owner per step: the
 *    driver while it is running, `state.work` once it has stopped (R1: a Cry fires exactly once).
 *  - It is also the order R113 wants, which R117 says follows from the rule above rather than being
 *    separate. `work.ts` parks at `state.workCursor`, which the pausing scope has just advanced past
 *    its own item, so the tail of a Cry's effect list — parked by the step that was running — lands
 *    in front of this one and resumes first: steps 6, 7 and 8 come *after* the Cry rather than
 *    inside it. Parking in advance put the pipeline ahead of that tail.
 *
 * Returns true when the pipeline is finished with (a game that ended under it included).
 */
function drive(sink: EngineSink, run: PlayRun): boolean {
  for (let at = Math.max(0, run.at); at < STEP_TABLE.length; at += 1) {
    const step = STEP_TABLE[at];
    if (step === undefined) break;

    // Where a pause would pick up. A `repeats` step is re-entered at itself, because it holds its
    // own place inside the record — and the record is read when the pause is parked, after the step
    // has moved that cursor, never before.
    const next = step.repeats === true ? at : at + 1;
    step.run(sink, run);

    if (sink.state.result !== null) return true;
    if (sink.state.pending !== null) {
      // Nothing to owe when the last step is the one that paused, and nothing to owe for a prompt
      // this pipeline opened itself: that prompt's own `resume` already carries the record, so a
      // work item would be a second copy of the same continuation (§10.5 step 6's fresh picks).
      if (run.awaiting === null && next < STEP_TABLE.length) {
        pushWork(sink, resumeFor(run, next), run.player);
      }
      return false;
    }
  }

  return true;
}

/** File an answered selection in the bucket the pause was waiting on (§10.5 step 6). */
function fileSelection(run: PlayRun, selection: readonly Selection[]): void {
  const awaiting = run.awaiting;
  run.awaiting = null;
  const repeat = run.repeat;
  if (repeat === null) return;
  if (awaiting === "echoTarget") repeat.targets.push(...selection);
  if (awaiting === "echoMode") {
    repeat.modes.push(...selection.flatMap((pick) => (pick.pick === "mode" ? [pick.option] : [])));
  }
}

/** The selection an answered prompt brought back, wherever the continuation carries it (§10.6). */
function selectionIn(data: Record<string, unknown>): Selection[] | null {
  const parked = pausedOf(data);
  if (parked !== null && parked.targets.length > 0) return parked.targets;
  for (const key of ["selection", "targets"]) {
    const raw = data[key];
    if (Array.isArray(raw) && raw.length > 0) return raw as Selection[];
  }
  return null;
}

/**
 * `work.ts`'s handler for the `"play"` sequence: the owed pipeline, continued where it stopped.
 * This is also how an answer to a prompt the pipeline opened itself comes back, since `prompts.ts`
 * re-enters a continuation no card script claims through its work handler (R113).
 */
function runOwedPlay(sink: EngineSink, item: WorkItem): void {
  const run = runOf(item.resume);
  if (run === null) return;

  // One continuation per play: whichever of them runs first drops the others, so a play that is
  // both owed and named by an answered prompt does not run its tail twice.
  dropWork(
    sink.state,
    (other) =>
      other.id !== item.id &&
      isPlayResume(other.resume) &&
      runOf(other.resume)?.instanceId === run.instanceId,
  );

  const selection = selectionIn(item.resume.data);
  if (selection !== null) fileSelection(run, selection);
  drive(sink, run);
}

registerWorkHandler(PLAY_WORK_KIND, runOwedPlay);

/**
 * `work.ts`'s handler for a cast's tail (R70, `echo.ts`'s `CAST_TAIL_WORK`): §10.5 steps 6 to 8 for
 * a card `resolve.castCard` has already played for 0, placed and resolved. It is the same driver
 * the play pipeline uses, entered at step 6, which is what makes a cast's repeats ask fresh prompts
 * and pause each other exactly as a play's do (§10.6, R81, R113) — and what makes the card land at
 * step 7, after the last repeat, rather than before the first.
 *
 * `resolve.ts` cannot call this directly: it sits below `prompts.ts`, which this module needs, so
 * the hand-over is an owed `WorkItem` and the resolution loop delivers it (see `echo.ts`'s header).
 * The repeats are already on `state.echoQueue` — `castCard` queued them, consuming R30's grant —
 * hence `echoQueued: true`.
 */
function runOwedCastTail(sink: EngineSink, item: WorkItem): void {
  const plan = castTailOf(item.resume);
  if (plan === null) return;

  drive(sink, {
    instanceId: plan.instanceId,
    defId: plan.defId,
    player: plan.controller,
    costPaid: 0,
    // Steps 1 to 5 were the cast's: the card is placed and its script has run (R70).
    zone: null,
    targets: [...plan.targets],
    modes: [...plan.modes],
    tributes: [],
    at: PLAY_STEPS.indexOf("echo"),
    hookAt: 0,
    resolveAt: RESOLVE_PARTS.length,
    echoQueued: true,
    repeat: null,
    awaiting: null,
  });
}

registerWorkHandler(CAST_TAIL_WORK, runOwedCastTail);

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * §10.5, all eight steps: validate the play, then run steps 2 to 8, pausing wherever a prompt
 * opens. Returns the refusal, or null once the play has run (or has owed itself the rest).
 */
export function runPlaySteps(sink: EngineSink, player: PlayerId, action: PlayAction): string | null {
  const checked = validatePlay(sink, player, action);
  if ("error" in checked) return checked.error;
  drive(sink, checked.run);
  return null;
}

/**
 * Answer a prompt this pipeline opened itself (§10.5 step 6's fresh picks), for a caller that has
 * the sequence in hand rather than going through `prompts.answerPrompt`: validate the answer the
 * same way, close the prompt, file the selection and drive on. `reduce` does not need this — an
 * answer goes to `prompts.answerPrompt`, which re-enters a continuation no card script claims
 * through this module's work handler (R113) — but the pipeline's own tests drive it directly.
 *
 * Returns the refusal, or null.
 */
export function answerPlayPrompt(sink: EngineSink, answer: AnswerInput): string | null {
  const pending = sink.state.pending;
  if (pending === null) return "no prompt is open";

  const refused = whyAnswerRefused(pending, answer);
  if (refused !== null) return refused;

  const run = runOf(resumeOf(pending));
  if (run === null) return "that prompt is not a play's own";

  closePrompt(sink);

  // The answered prompt is this run's, so any tail owed for it earlier would repeat this step.
  dropWork(sink.state, (item) => isPlayResume(item.resume) && runOf(item.resume)?.instanceId === run.instanceId);
  fileSelection(run, answer.selection);
  drive(sink, run);
  return null;
}
