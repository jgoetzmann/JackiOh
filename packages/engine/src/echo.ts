// Echo: SPEC §6.3's Echo row, §10.5 step 6 and R30's Twinspell lifetime — what a resolution owes,
// where the repeats wait, and where the card lands once they are done (BUILD M3-T2, R30, R70, R113).
//
// §6.3: "Echo X | Recast this card X more times | Play resolves, then the same instance re-resolves
// X times with fresh mode/target prompts; Twinspell grants Echo +1 to the next spell." The repeats
// outstanding are state, never a loop variable: one `EchoItem` per instance on `state.echoQueue`
// (§10.1), taken one at a time, so a prompt inside one repeat pauses the rest (§9.3, R113).
//
// Why Echo is its own module rather than a section of `playSteps.ts`: what the play pipeline and
// its readers share here is state and rules, not prompting — the queue, the printed `Echo X`, R30's
// grant and where a resolved card goes (§10.5 step 7) — and `viewFor.ts` reads the grant for R169's
// badge. A cast is the same pipeline (R70: "a cast Spell does use Twinspell's Echo"), entered by
// `resolve.castCard` through the driver `playSteps.ts` registers. This file imports no module that
// imports `resolve.ts`, and takes `EngineSink` as a type, which is erased.
//
// Asking a repeat's fresh prompts (§10.6 "an Echo repeat of Glowy Jelly Bean reopens its hand
// pick", R81) is the other half of step 6, and it stays with the pipeline driver in `playSteps.ts`,
// the one side that may import `prompts.ts`.

import type { PlayerId } from "@jackioh/shared";
import { defOf } from "./catalog";
import { modifierIsLive } from "./mana";
import { installLastingModifiers, removeModifier } from "./modifiers";
import type { EngineSink } from "./resolve";
import { flagsOf } from "./scripts";
import { leftFieldAfter } from "./stays";
import {
  findInstance,
  type CardInstance,
  type EchoItem,
  type GameState,
  type PlayerModifier,
} from "./state";
import { moveToZone } from "./zones";

// ---------------------------------------------------------------------------
// The queue (§10.1 `echoQueue`)
// ---------------------------------------------------------------------------

/** The repeats this instance still owes, as one queue entry per instance (§10.1 `EchoItem`). */
function echoEntry(state: GameState, instanceId: string): EchoItem | undefined {
  return state.echoQueue.find((item) => item.instanceId === instanceId);
}

/** How many repeats this instance is still owed, for a caller that only wants to know. */
export function echoRepeatsOwed(state: GameState, instanceId: string): number {
  return Math.max(0, echoEntry(state, instanceId)?.remaining ?? 0);
}

/**
 * Add repeats to this instance's entry, creating it when it has none. The id and `seq` come from
 * `state.nextId`/`state.nextSeq`, as every queue entry's do, so a replay builds the queue the live
 * game had (R68).
 */
export function addEchoRepeats(
  sink: EngineSink,
  card: CardInstance,
  controller: PlayerId,
  count: number,
): number {
  const state = sink.state;
  if (count <= 0) return echoRepeatsOwed(state, card.id);

  const existing = echoEntry(state, card.id);
  if (existing !== undefined) {
    existing.remaining += count;
    return existing.remaining;
  }
  state.echoQueue.push({
    id: `e${state.nextId}`,
    seq: state.nextSeq,
    instanceId: card.id,
    controller,
    remaining: count,
  });
  state.nextId += 1;
  state.nextSeq += 1;
  return count;
}

/** Take one repeat off this instance's entry, dropping the entry once it owes nothing. */
export function takeEchoRepeat(state: GameState, instanceId: string): boolean {
  const entry = echoEntry(state, instanceId);
  if (entry === undefined || entry.remaining <= 0) return false;
  entry.remaining -= 1;
  if (entry.remaining <= 0) state.echoQueue = state.echoQueue.filter((item) => item !== entry);
  return true;
}

/**
 * Forget every repeat this instance is owed: it is no longer there to re-resolve (a trap took it
 * off, it ceased to exist), so the entry would otherwise wait in `state.echoQueue` for ever. The
 * repeats were queued as the card was played (§10.5 step 4), before anything could remove it.
 */
export function dropEchoRepeats(state: GameState, instanceId: string): void {
  state.echoQueue = state.echoQueue.filter((item) => item.instanceId !== instanceId);
}

// ---------------------------------------------------------------------------
// What a resolution owes (§6.3, R30)
// ---------------------------------------------------------------------------

/** §6.1: the card's own printed Echo X (`staticFlags.echo`). */
export function printedEcho(card: CardInstance): number {
  return Math.max(0, Math.trunc(flagsOf(card).echo ?? 0));
}

/**
 * How much Echo one rider grants now. A rider a permanent installed (`sourceId`, #79 Twinspell) is
 * that permanent's lasting effect (§5.1, R209), so it grants only while the permanent is on the
 * field under the rider's player, and it grants what the permanent's face says NOW: §5.2 has a card
 * made Radiant on the field run its radiant text from then on, so a Twinspell #49 radiant steals
 * says "Echo +2" (`staticFlags.echoGrant`) whatever its base face installed. A rider with no source
 * (an engine or test fixture) grants its own `amount`. Returns 0 for a rider whose permanent has
 * gone, which the state check would end anyway (R209).
 */
export function echoGrantOf(state: GameState, player: PlayerId, mod: PlayerModifier): number {
  if (mod.kind !== "echoNextSpell") return 0;
  if (mod.sourceId === undefined) return Math.max(0, mod.amount);
  const source = findInstance(state, mod.sourceId);
  if (source === undefined || source.zone.z !== "field" || source.controller !== player) return 0;
  return Math.max(0, Math.trunc(flagsOf(source).echoGrant ?? mod.amount));
}

/**
 * R30: Twinspell grants Echo to the next Spell and "stays until a spell is played, then goes to the
 * GY". The grant is spent here — when it applies — and the Field Spell that gave it follows. Only a
 * Spell takes it ("the next Spell you play"), so a cast or played permanent leaves it armed, and
 * R70 makes a cast Spell take it like any other.
 *
 * R209: one grant per Twinspell on the field. Every rider a permanent owns is spent with it, but only
 * the first counts, so a Twinspell that left the field and came back between two state checks —
 * the second stay installing a second rider before the first was ended — still echoes once.
 */
export function grantedEcho(sink: EngineSink, player: PlayerId, card: CardInstance): number {
  const state = sink.state;
  if (defOf(state, card.defId).type !== "Spell") return 0;
  // R209: a Twinspell that arrived since the last state check — summoned mid-effect ahead of a cast
  // on draw — already stands on the field, so its rider is installed before the Spell reads them.
  installLastingModifiers(sink);

  let granted = 0;
  const spent = new Set<string>();
  const mods: PlayerModifier[] = [...state.players[player].mods];
  for (const mod of mods) {
    if (mod.kind !== "echoNextSpell" || !modifierIsLive(state, mod)) continue;
    const amount = echoGrantOf(state, player, mod);
    removeModifier(sink, player, mod.id);
    if (mod.sourceId === undefined) {
      granted += amount;
      continue;
    }
    if (amount <= 0 || spent.has(mod.sourceId)) continue;
    spent.add(mod.sourceId);
    granted += amount;

    const source = findInstance(state, mod.sourceId);
    if (source === undefined || source.zone.z !== "field") continue;
    if (moveToZone(state, source, "graveyard") !== "moved") continue;
    sink.events.push({
      type: "enteredGraveyard",
      instanceId: source.id,
      defId: source.defId,
      owner: source.owner,
    });
  }
  return granted;
}

/**
 * Work out what this resolution owes and put it on the queue, once: the card's printed `Echo X`
 * plus whatever R30's grant adds. Returns how many repeats are owed now, so a caller that has to
 * decide whether to hand off a tail at all can ask in one line.
 *
 * Called exactly once per resolution — §10.5 step 4 calls it as the card is played, for a play from
 * hand and for a cast alike, and sets the run's `echoQueued` flag (R178: a Spell gains its Echo as
 * it is played) — because it *consumes* the grant.
 */
export function queueEchoRepeats(sink: EngineSink, card: CardInstance, player: PlayerId): number {
  return addEchoRepeats(sink, card, player, printedEcho(card) + grantedEcho(sink, player, card));
}

// ---------------------------------------------------------------------------
// Where the card lands afterwards, and saying so (§10.5 step 7, R17)
// ---------------------------------------------------------------------------

/**
 * R178: the mark a resolving Spell's own "exile this" leaves (#39, #44, #72, #76, #87, #97). §10.5
 * puts "Spells go to the GY or exile" at step 7, after step 6's Echo repeats, and §6.2 has "the same
 * instance re-resolve" — so a Spell that says "exile this" is still resolving until step 7, which
 * sends it to exile instead of the graveyard. Moving it at once had it leave before its own
 * repeats: Twinspell's grant (R30) was never taken and the repeats never came.
 *
 * It lives in the card's own `memory`, which is JSON (§10.1), and step 7 clears it as it acts.
 */
export const EXILE_ON_LANDING = "@exileOnLanding";

/** R178: send this resolving Spell to exile when §10.5 step 7 lands it, rather than now. */
export function exileOnLanding(card: CardInstance): void {
  card.memory[EXILE_ON_LANDING] = true;
}

/** Which resolution is finishing, so the event can be emitted for a card that no longer exists. */
export type ResolvedCard = {
  instanceId: string;
  defId: string;
  /** The player who played or cast it, which `cardResolved` reports. */
  player: PlayerId;
  /**
   * The mana actually charged, which is the same number `cardPlayed` reports: after every modifier,
   * with R65's X and embiggen prices included, and 0 for a cast (R70: "a cast is free and counts as
   * a play … with cost paid 0"). The caller passes it because R89 is the hazard — a trigger
   * answering this event must find what it needs ON the event, since the instance may have been
   * reset between step 4 and step 7 — so #60 Bear Honeypot's "costing 1 or less" (R56: "the cost
   * actually paid after modifiers") is never looked up off the board.
   */
  costPaid: number;
  /**
   * The face the card was played with (after §10.5 step 3's Gifted Program hook), for a card that
   * has ceased to exist by step 7 — Sheepish transformed it at step 4 — so the event can still say
   * what resolved (R34, R57).
   */
  radiant: boolean;
  /**
   * R174, R61: the field's departures once §10.5 step 4 had put a permanent on the field. "Still in
   * play" is asked of that stay: a played unit that died in its own resolution (its Cry, or the check
   * after step 6) and is back through Reborn by step 7 is a new arrival (R83), not the card that was
   * played, so #60's tokens do not attack it and #85 does not fuse it away.
   */
  placedFrom?: number;
  /** R119: the permanents the play put onto the field while it resolved, which do not answer it. */
  arrivedDuring?: readonly string[];
};

/**
 * §10.5 step 7, both halves, for a play and for a cast (R70) alike.
 *
 * Where the card lands: "Spells go to the GY or exile" — and only now, after the script and every
 * Echo repeat have run, so a repeat that reads a graveyard does not find the card already in it
 * (the M3 review filed the other order as B-4). A card a script sent somewhere else, and a
 * permanent that step 4 put on the field, have already left `resolving`, so nothing moves for them.
 *
 * Then `cardResolved`, the moment §10.5 step 7 and R17 name: "Unstable Clone Machine and Bear
 * Honeypot fire after resolution; Unlicensed Experimentation fires after a played permanent's Cry
 * (R61)", as against Sheepish, which answers step 4's `summoned` and costs the card its Cry. It is
 * emitted exactly once per resolution — this is step 7, which runs after step 6 has drained every
 * repeat — and `permanent` says whether the card is still in play, which is R61's distinction. A
 * card that has left play by now (a Spell in its graveyard, a unit a trap took, a token that ceased
 * to exist) reports `permanent: false`, and the event still names it, so a trap can see what
 * resolved. `costPaid` rides along for the same reason: R89 has a trigger read the event rather
 * than the board, so the caller hands over the number it charged (0 for a cast, R70) and #60 Bear
 * Honeypot's R56 threshold never re-derives a cost from an instance step 7 may have reset.
 */
/** R61, R174: whether the card the play put on the field is still in play, on that same stay. */
function stillInPlay(sink: EngineSink, resolved: ResolvedCard): boolean {
  const card = findInstance(sink.state, resolved.instanceId);
  if (card === undefined || card.zone.z !== "field") return false;
  return resolved.placedFrom === undefined || !leftFieldAfter(sink.state, resolved.placedFrom, card.id);
}

export function landAfterResolution(sink: EngineSink, resolved: ResolvedCard): void {
  const state = sink.state;
  const card = findInstance(state, resolved.instanceId);

  if (card !== undefined && card.zone.z === "resolving" && card.memory[EXILE_ON_LANDING] === true) {
    // R178: the Spell's own "exile this", carried out at the step §10.5 gives it.
    delete card.memory[EXILE_ON_LANDING];
    if (moveToZone(state, card, "exile") === "moved") state.counters.exiled += 1;
    sink.events.push({ type: "exiled", instanceId: card.id, defId: card.defId, owner: card.owner });
  } else if (card !== undefined && card.zone.z === "resolving" && moveToZone(state, card, "graveyard") === "moved") {
    sink.events.push({
      type: "enteredGraveyard",
      instanceId: card.id,
      defId: card.defId,
      owner: card.owner,
    });
  }

  sink.events.push({
    type: "cardResolved",
    player: resolved.player,
    instanceId: resolved.instanceId,
    defId: resolved.defId,
    permanent: stillInPlay(sink, resolved),
    costPaid: resolved.costPaid,
    radiant: findInstance(state, resolved.instanceId)?.radiant ?? resolved.radiant,
    ...(resolved.arrivedDuring === undefined || resolved.arrivedDuring.length === 0
      ? {}
      : { arrivedDuring: [...resolved.arrivedDuring] }),
  });
}
