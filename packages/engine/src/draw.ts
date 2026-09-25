// Drawing, fatigue, the hand cap, cast-on-draw chains and the library cap
// (SPEC §2.4, R3, R4, R58, R80), the arrival hook of R151, and — since a cast-on-draw card is a
// whole play and a play can ask — both draw loops resuming out of `state.work` across a prompt
// (§9.3, §10.6, R113, R117, R122).

import type { LibraryOverflowOutcome, PlayerId } from "@jackioh/shared";
import { CAST_ON_DRAW_CHAIN_CAP, FATIGUE_DAMAGE, HAND_CAP, LIBRARY_CAP } from "./config";
import { defByIndex } from "./catalog";
import { dealDamage } from "./damage";
import { runStartOfGame } from "./prompts";
import { castCard, type EngineSink } from "./resolve";
import { flagsOf } from "./scripts";
import {
  newInstance,
  type CardInstance,
  type GameState,
  type PendingChoice,
  type Resume,
  type WorkItem,
} from "./state";
import { stateCheck } from "./stateCheck";
import { owe, paused, registerWorkHandler } from "./work";
import { cardAt, isUnitToken, moveToZone, slotsOf } from "./zones";

/**
 * R151: a card whose script has a start-of-game hook runs it when it ARRIVES in a hand or a
 * library, and not only at §2.1 step 4. R43 words the rule as an invariant rather than as a moment —
 * "at start of game every Heroic Power in either player's hand or library rolls its power … and one
 * that ends up in a hand or library with no `memory.power` (a bounced or reset instance, R78) rolls
 * as it arrives" — so a copy that reaches a hand later (#72 Reminisce out of a graveyard, a bounce,
 * a draw, a card an effect created) has to roll too, or it carries no power and costs 0 for ever.
 *
 * GENERAL, NOT #98 BY ID: the test is `scriptOf(card).startOfGame`, the same thing `setup.finishSetup`
 * reads, so any card that ever grows a start-of-game clause is covered without the engine naming a
 * catalog id. Re-running it is safe because the hook is the one that owns its own idempotence:
 * `heroPower.ensurePower` keeps a power a card already rolled ("which is why it is idempotent rather
 * than a plain roll"), so an arrival costs no rng draw once the card has its answer.
 *
 * WHY HERE AND NOT IN `zones.moveToZone`, the single point every zone change goes through: the roll
 * needs the match rng, and `moveToZone` takes a `GameState`, which holds only the seed and the stored
 * cursor. A fresh `createRng(state.seed, state.rngCursor)` mid-action would repeat draws the action's
 * own rng has already taken, and `reduce` ends every action with `next.rngCursor = sink.rng.cursor`,
 * so the cursor it advanced would be discarded — two determinism bugs for one convenience. These two
 * functions are the sink-holding funnels §2.4 already routes every hand and library arrival through
 * (see the header of `effects/addToHand.ts`: "Both routes end in `../draw`'s `addToHand`").
 */
function runArrivalHooks(sink: EngineSink, instance: CardInstance): void {
  // §9.3, R113: the clause is an effect list like any other, so a question in it pauses the rest of
  // it on `state.work` (`prompts.runStartOfGame`), and a draw loop around it owes its remainder.
  runStartOfGame(sink, instance, instance.owner);
}

/** #75: a backrow card that turns an empty-library draw into a Rush Token card. */
function infiniteReservesSource(sink: EngineSink, player: PlayerId): CardInstance | null {
  for (const ref of slotsOf(player, "backrow")) {
    const card = cardAt(sink.state, ref);
    if (card !== null && flagsOf(card).infiniteReserves === true) return card;
  }
  return null;
}

/** §2.4, R4: a card entering a full hand is burned to the graveyard; unit tokens vanish (R11). */
export function addToHand(sink: EngineSink, instance: CardInstance): "hand" | "burned" {
  const side = sink.state.players[instance.owner];
  if (side.hand.length >= HAND_CAP) {
    const token = isUnitToken(sink.state, instance);
    moveToZone(sink.state, instance, "graveyard");
    sink.events.push({
      type: "burned",
      instanceId: instance.id,
      defId: instance.defId,
      owner: instance.owner,
    });
    if (!token) {
      sink.events.push({
        type: "enteredGraveyard",
        instanceId: instance.id,
        defId: instance.defId,
        owner: instance.owner,
      });
    }
    return "burned";
  }
  moveToZone(sink.state, instance, "hand");
  sink.events.push({
    type: "addedToHand",
    player: instance.owner,
    instanceId: instance.id,
    defId: instance.defId,
  });
  // R151: it has arrived somewhere it can be looked at, so a start-of-game clause runs now.
  runArrivalHooks(sink, instance);
  return "hand";
}

/**
 * R80: a library holds at most LIBRARY_CAP cards, so copies stop being created at the cap, and an
 * existing card goes to its owner's graveyard instead (a unit-token card ceases to exist, R11).
 *
 * R316: whichever it is, the refusal is reported by `libraryOverflow`, so the board can show the
 * full library turning the card away. Nothing else reported a copy that was never made, and an
 * existing unit-token card that ceased to exist here moved with no event at all (§10.3).
 */
export function shuffleIntoLibrary(sink: EngineSink, instance: CardInstance, existing: boolean): "library" | "dropped" {
  const side = sink.state.players[instance.owner];
  if (side.library.length >= LIBRARY_CAP) {
    const refused = (outcome: LibraryOverflowOutcome): void => {
      sink.events.push({
        type: "libraryOverflow",
        player: instance.owner,
        instanceId: instance.id,
        defId: instance.defId,
        outcome,
      });
    };
    if (!existing) {
      refused("notCreated");
      return "dropped";
    }
    if (isUnitToken(sink.state, instance)) {
      moveToZone(sink.state, instance, "exile");
      refused("ceased");
      return "dropped";
    }
    moveToZone(sink.state, instance, "graveyard");
    refused("graveyard");
    sink.events.push({
      type: "enteredGraveyard",
      instanceId: instance.id,
      defId: instance.defId,
      owner: instance.owner,
    });
    return "dropped";
  }
  const position = sink.rng.int(side.library.length + 1);
  moveToZone(sink.state, instance, "library", { position });
  sink.events.push({
    type: "shuffledIn",
    player: instance.owner,
    instanceId: instance.id,
    defId: instance.defId,
    position,
  });
  // R151: R43 names a library as well as a hand, so a card shuffled back rolls the same way.
  runArrivalHooks(sink, instance);
  return "library";
}

export type DrawOutcome = "drawn" | "cast" | "burned" | "fatigue" | "token";

// ---------------------------------------------------------------------------
// Drawing across a prompt (§9.3, §10.6, R113, R117, R122)
// ---------------------------------------------------------------------------

/**
 * §2.4 has two loops, and a prompt can open in the middle of either one.
 *
 *   * the cast-on-draw CHAIN inside `completeDraw`: the cast is a whole play (R70), and a play can
 *     ask — #7 Jewelosco Scarab's Discover drawn off the top, or anything Call to Chaos reaches.
 *   * the "draw N" loop inside `draw`: N separate draws, each with its own chain (§2.4, R58), so
 *     draw 2 with #95 Call to Chaos is two chains and the first of them can pause.
 *
 * Both used to walk straight on over the open prompt, drawing cards into a game state the player had
 * not finished deciding — the same class of bug as any sequence that keeps its place in a local
 * variable (§9.3: "mid-action choices are state, not callbacks"). So each loop gates on
 * `work.paused` and parks what it still owes on `state.work`, which the answer's drain picks up
 * (R113, R122). Two kinds rather than one, because they are two different remainders and each
 * handler is then exactly its own loop:
 *
 *   * `DRAW_CHAIN_WORK` owes "one more draw, continuing this chain at `chain`" — one item carrying
 *     the counter, so R58's cap still bounds the chain a pause split in half. A resumed chain counts
 *     on from where it stopped and can never restart at zero, which is what would let a chain evade
 *     the cap by pausing.
 *   * `DRAW_COUNT_WORK` owes "`count` more whole draws", each starting a fresh chain at 0.
 *
 * R117: both are parked at the moment of the pause and never in advance. While the loop is on the
 * stack the draws it has not made are the loop's alone, so a resolution loop running *inside* one of
 * them — a cast's Cry can start one — can neither take nor re-run the draws it is standing in.
 * Pre-parking the remainder is what made a played card's Cry fire twice earlier in this project.
 *
 * R113's order falls out of `work.pushWork` placing at `state.workCursor`: a chain that pauses parks
 * its own remainder first and the enclosing "draw N" loop parks after it, so the interrupted chain
 * finishes before the next whole draw begins. Nothing but plain JSON is held, so a paused draw
 * survives `JSON.parse(JSON.stringify(state))` and replays exactly (§9.3, §10.1).
 *
 * The game ending parks nothing: like `traps.oweWindow` and `resolve.castCard`, there is nothing
 * left to resume into once `state.result` is set, and R3's fatigue is the usual way a draw ends one.
 */
export const DRAW_CHAIN_WORK = "@drawChain";

const DRAW_CHAIN_STEP = "chain";

/**
 * R58: one more draw continuing a chain, and the count it must continue from. `owns` is set when
 * the chain is the one a draw of its own began, rather than one a draw inside some cast of it
 * continues (R217), so the item that finishes it is the one that closes `state.castChain`.
 */
export type OwedDrawChain = { player: PlayerId; chain: number; owns: boolean };

/**
 * Where a draw stands in a cast-on-draw chain: the casts the chain has made so far, and whether
 * this draw's chain is its own to close (R217). A draw that continues a chain after a cast passes
 * its link on; a fresh draw — "draw N", a Combo draw, #30's named draw — reads it off the state.
 */
export type ChainLink = { chain: number; owns: boolean };

/**
 * R217: a fresh draw made while a chain is running — by one of the chain's casts, whose Combo draw
 * or own "draw 1" is part of the cast — continues that chain's count instead of starting its own, so
 * R58's cap bounds everything one draw sets off. Otherwise it begins a chain of its own at 0.
 */
function linkFor(state: GameState, link: ChainLink | number | undefined): ChainLink {
  if (typeof link === "object") return { chain: state.castChain ?? link.chain, owns: link.owns };
  // A count given on its own (a caller starting a chain part-way, as the engine's tests do) is a
  // chain of its own at that count, unless a running one takes it over.
  return { chain: state.castChain ?? link ?? 0, owns: state.castChain === undefined };
}

/** The draw that began a chain has finished it, or the game ended under it: nothing is running. */
function closeChain(state: GameState, link: ChainLink): void {
  if (link.owns) delete state.castChain;
}

export const DRAW_COUNT_WORK = "@drawCount";

const DRAW_COUNT_STEP = "draws";

/** §2.4: whole draws a "draw N" still owes, each of which starts its own chain. */
export type OwedDrawCount = { player: PlayerId; count: number };

/**
 * Whether a draw loop must stop where it stands and park the rest. `work.paused` is the test — a
 * prompt is open, or the game is over — with the one qualification R117 already implies: the pause a
 * sequence owes its remainder for is the one *it* caused.
 *
 * That qualification is load-bearing here and nowhere else in the engine, because §2.1's mulligan is
 * the one caller that draws underneath an open prompt: `setup.answerMulligan` draws the replacements
 * and only then clears `state.pending`, since R9 wants the replacements drawn before the returned
 * cards are shuffled back. A prompt that was already open when this draw began is not this draw's
 * pause, and stopping on it would owe R9's replacement draws to an action that never makes them.
 * The before/after comparison is the same one `resolve.applyHookResumable` makes across the effects
 * of a single hook, for the same reason.
 *
 * The game ending is unconditional: `state.result` stops every sequence, and `traps.oweWindow` and
 * `resolve.castCard` both park nothing past it, because there is nothing left to resume into.
 */
function stopped(sink: EngineSink, before: PendingChoice | null): boolean {
  if (!paused(sink)) return false;
  if (sink.state.result !== null) return true;
  return sink.state.pending !== before;
}

/** It came back through JSON (§10.1), so nothing about the payload is assumed. */
function playerOf(data: Record<string, unknown>): PlayerId | null {
  const player: unknown = data.player;
  return player === "p1" || player === "p2" ? player : null;
}

function countOf(data: Record<string, unknown>, key: string): number {
  const value: unknown = data[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/** What a `DRAW_CHAIN_WORK` item owes, or null when it is not one: the reader for its payload. */
export function owedDrawChainOf(resume: Resume): OwedDrawChain | null {
  if (resume.hook !== DRAW_CHAIN_WORK) return null;
  const player = playerOf(resume.data);
  // An item parked before R217 carries no `owns`, and its chain was always its own draw's.
  const owns = resume.data.owns !== false;
  return player === null ? null : { player, chain: countOf(resume.data, "chain"), owns };
}

/** What a `DRAW_COUNT_WORK` item owes, or null when it is not one. */
export function owedDrawCountOf(resume: Resume): OwedDrawCount | null {
  if (resume.hook !== DRAW_COUNT_WORK) return null;
  const player = playerOf(resume.data);
  return player === null ? null : { player, count: countOf(resume.data, "count") };
}

/**
 * Park the rest of a chain (R113). `work.ts` owns `state.work`, so this only ever calls `owe`: the
 * item lands at `state.workCursor`, which puts it behind anything the pausing cast parked inside it
 * — its own Cry tail, §10.5 steps 6 and 7 — and in front of everything else still owed.
 */
function oweChain(sink: EngineSink, player: PlayerId, link: ChainLink): void {
  const resume: Resume = {
    defId: "",
    hook: DRAW_CHAIN_WORK,
    step: DRAW_CHAIN_STEP,
    radiant: false,
    data: { player, chain: sink.state.castChain ?? link.chain, owns: link.owns },
  };
  owe(sink, resume);
}

/** A chain stopped where it stands: owed to the answer, or closed for a game that is over. */
function stopChain(sink: EngineSink, player: PlayerId, link: ChainLink): void {
  if (sink.state.result === null) oweChain(sink, player, link);
  else closeChain(sink.state, link);
}

/** Park the whole draws a "draw N" has not made yet (R113), behind the chain that interrupted it. */
function oweDraws(sink: EngineSink, player: PlayerId, count: number): void {
  if (count <= 0) return;
  const resume: Resume = {
    defId: "",
    hook: DRAW_COUNT_WORK,
    step: DRAW_COUNT_STEP,
    radiant: false,
    data: { player, count },
  };
  owe(sink, resume);
}

/**
 * §2.4's draw from the moment the card has left the library: the game draw counter, the `drawn`
 * event, R58's cast-on-draw chain and R4's hand cap.
 *
 * `drawOne` below takes the top card and `effects/draw.ts`'s `drawFromLibrary` takes a NAMED one
 * (#30 Archivist's highest and lowest, #94 Genn's Greed's every 2-cost card), and both end here, so
 * "a draw" means exactly one thing however the card was chosen (§6.3 Draw). The caller splices the
 * card out of the library first: the pile must already be short by one when a cast-on-draw card
 * resolves, or its own script would read a library that still holds it.
 */
export function completeDraw(
  sink: EngineSink,
  player: PlayerId,
  card: CardInstance,
  link?: ChainLink | number,
): DrawOutcome {
  const state = sink.state;
  state.counters.drawn += 1;
  sink.events.push({ type: "drawn", player, instanceId: card.id, defId: card.defId });

  const at = linkFor(state, link);
  if (flagsOf(card).castOnDraw === true && at.chain < CAST_ON_DRAW_CHAIN_CAP) {
    // R58, R217: counted before the cast resolves, so a draw the cast makes continues from here.
    state.castChain = at.chain + 1;
    card.zone = { z: "resolving", player };
    const before = state.pending;
    castCard(sink, card);

    // §9.3 and R122: the cast is a whole play and a play can ask, so the repeat of the draw belongs
    // to the action that answers, not to this one. Drawing on here would put cards in the hand — and
    // cast more of them — while the player is still being asked about this one. What is owed is one
    // more draw at the chain's count, which is precisely the count this draw would have passed on, so
    // R58's cap bounds the resumed chain exactly as it bounds an uninterrupted one (R113, R117).
    if (stopped(sink, before)) {
      stopChain(sink, player, at);
      return "cast";
    }

    continueChain(sink, player, at.owns, before);
    return "cast";
  }

  return addToHand(sink, card) === "burned" ? "burned" : "drawn";
}

/**
 * §2.4's repeat, after a cast-on-draw cast has resolved whole — its Echo repeats and its landing
 * included, since a cast is §10.5's pipeline (R70). §4.5 and R59 run the state check "after one
 * cast-on-draw cast", so a hero the cast brought to 0 ends the game here and the draw does not
 * repeat into the card beneath, and a unit it killed has died before the next card is cast. A Death
 * hook that asks stops the chain like any other pause, owing the draw it would have made.
 *
 * The repeat reads the chain's count off the state, not the count this draw passed on: the cast may
 * have drawn and cast more of the same chain itself (R217). The draw that began the chain closes it
 * once its repeat is done.
 */
function continueChain(sink: EngineSink, player: PlayerId, owns: boolean, before: PendingChoice | null): void {
  const link: ChainLink = { chain: sink.state.castChain ?? 0, owns };
  stateCheck(sink);
  if (stopped(sink, before)) {
    stopChain(sink, player, link);
    return;
  }
  drawOne(sink, player, { chain: sink.state.castChain ?? link.chain, owns });
  // A pause further down the chain parked its own repeat with `owns`, and that item closes it.
  if (!stopped(sink, before) || sink.state.result !== null) closeChain(sink.state, link);
}

/**
 * One draw (§2.4). A cast-on-draw card resolves at once and the draw repeats, up to
 * CAST_ON_DRAW_CHAIN_CAP casts (R58); the next such card goes to hand uncast and ends the chain.
 * `link` is the chain a repeat continues; a fresh draw passes none (R217).
 */
export function drawOne(sink: EngineSink, player: PlayerId, link?: ChainLink | number): DrawOutcome {
  const side = sink.state.players[player];

  if (side.library.length === 0) {
    const reserves = infiniteReservesSource(sink, player);
    if (reserves !== null) {
      const tokenDef = defByIndex("T-rush");
      if (tokenDef !== undefined) {
        const token = newInstance(sink.state, tokenDef.id, player, { z: "hand", player });
        sink.state.counters.drawn += 1;
        sink.events.push({ type: "drawn", player, instanceId: token.id, defId: token.defId });
        addToHand(sink, token);
        return "token";
      }
    }
    // No card is drawn, so no `drawn` event: the damage instance is what happened (§2.4, R3).
    // R315: `fatigue` announces it first, so the board shows the empty library before the hit
    // lands; it is a report and answers nothing, like R240's zero-damage one below.
    side.fatigueCount += 1;
    const amount = FATIGUE_DAMAGE(side.fatigueCount);
    sink.events.push({ type: "fatigue", player, count: side.fatigueCount, amount });
    const dealt = dealDamage(sink, { source: null, target: { kind: "hero", player }, amount });
    // R240: a fatigue draw whose hit the hero's Armor takes whole (§4.4 step 2; step 3's cap only
    // clamps) still happened — the public count moved and the next one deals more (§10.3) — so it is
    // reported by a hit of 0 from no source, which is a report and no damage instance: nothing
    // answers it (R63, `triggers.dispatchEvent`).
    if (dealt <= 0 && sink.state.result === null) {
      sink.events.push({ type: "damage", sourceId: null, targetId: `hero-${player}`, amount: 0, combat: false });
    }
    return "fatigue";
  }

  const card = side.library[0] as CardInstance;
  side.library.splice(0, 1);
  return completeDraw(sink, player, card, link);
}

/**
 * §2.4: "Draw N is N separate draws, each with its own chain" (R58). A draw that pauses stops the
 * rest of them, which are owed to `state.work` and made by the action that answers (R113, R122) —
 * so the outcomes this returns are the draws that really happened in this action, and a caller that
 * counts them reads a short list rather than a list of draws that have not happened yet.
 */
export function draw(sink: EngineSink, player: PlayerId, count: number): DrawOutcome[] {
  const before = sink.state.pending;
  const out: DrawOutcome[] = [];
  for (let i = 0; i < count; i += 1) {
    // R216: a draw whose cast, or the check after it, ended the game ends the draws with it.
    if (sink.state.result !== null) return out;
    out.push(drawOne(sink, player));
    if (!stopped(sink, before)) continue;
    // R117: parked here, at the pause, and never in advance. The chain that stopped has already
    // parked its own remainder, so this lands behind it and the interrupted chain finishes first.
    if (sink.state.result === null) oweDraws(sink, player, count - i - 1);
    return out;
  }
  return out;
}

/**
 * `work.ts`'s handler for a chain a cast-on-draw prompt split: the same chain, at the same count.
 * The cast that paused has finished by now — its own items were parked ahead of this one (R113) —
 * so the state check it is owed runs before the draw repeats, as it does in an unbroken chain.
 */
function runOwedDrawChain(sink: EngineSink, item: WorkItem): void {
  const owed = owedDrawChainOf(item.resume);
  if (owed === null) return;
  // The count is the state's while the chain runs; an item parked before R217 kept its own.
  if (sink.state.castChain === undefined && owed.owns) sink.state.castChain = owed.chain;
  continueChain(sink, owed.player, owed.owns, sink.state.pending);
}

/** `work.ts`'s handler for the whole draws a "draw N" still owed when one of them paused. */
function runOwedDrawCount(sink: EngineSink, item: WorkItem): void {
  const owed = owedDrawCountOf(item.resume);
  if (owed === null) return;
  draw(sink, owed.player, owed.count);
}

// Registered at module scope, in the module that owns the sequence, and never from a test: a
// handler is code, so a suite that wired it up on production's behalf would be green over a
// production that had no wiring at all (R113).
registerWorkHandler(DRAW_CHAIN_WORK, runOwedDrawChain);
registerWorkHandler(DRAW_COUNT_WORK, runOwedDrawCount);
