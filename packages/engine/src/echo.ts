// Echo: SPEC §6.3's Echo row, §10.5 step 6 and R30's Twinspell lifetime — what a resolution owes,
// where the repeats wait, and where the card lands once they are done (BUILD M3-T2, R30, R70, R113).
//
// §6.3: "Echo X | Recast this card X more times | Play resolves, then the same instance re-resolves
// X times with fresh mode/target prompts; Twinspell grants Echo +1 to the next spell." The repeats
// outstanding are state, never a loop variable: one `EchoItem` per instance on `state.echoQueue`
// (§10.1), taken one at a time, so a prompt inside one repeat pauses the rest (§9.3, R113).
//
// Why Echo is its own module rather than a section of `playSteps.ts`: two resolutions can owe
// repeats. A play owes them at §10.5 step 6, and a cast owes them too — R70: "A cast never uses a
// cost discount, since it pays nothing, but a cast Spell does use Twinspell's Echo". The play
// pipeline sits above `prompts.ts`, and `prompts.ts` imports `resolve.ts`, so `resolve.castCard`
// cannot call up into the pipeline without an import cycle (`resolve → … → prompts → resolve`).
// What the two paths actually share is state and rules, not prompting: the queue, the printed
// `Echo X`, R30's grant and where a resolved card goes (§10.5 step 7). Those live here, below both
// callers — this file imports no module that imports `resolve.ts`, and takes `EngineSink` as a
// type, which is erased.
//
// Asking a repeat's fresh prompts (§10.6 "an Echo repeat of Glowy Jelly Bean reopens its hand
// pick", R81) is the other half of step 6, and it stays with the pipeline driver in `playSteps.ts`,
// the one side that may import `prompts.ts`. A cast therefore hands its tail — the repeats, then
// the landing — to that driver as an ordinary owed `WorkItem` (`CAST_TAIL_WORK`), which is R113's
// mechanism and not a closure; `work.ts` raises rather than dropping an item no handler claims, so
// a cast can never lose its repeats in silence.

import type { PlayerId, Selection } from "@jackioh/shared";
import { defOf } from "./catalog";
import { modifierIsLive } from "./mana";
import { removeModifier } from "./modifiers";
import type { EngineSink } from "./resolve";
import { flagsOf } from "./scripts";
import {
  findInstance,
  type CardInstance,
  type EchoItem,
  type GameState,
  type PlayerModifier,
  type Resume,
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

// ---------------------------------------------------------------------------
// What a resolution owes (§6.3, R30)
// ---------------------------------------------------------------------------

/** §6.1: the card's own printed Echo X (`staticFlags.echo`). */
export function printedEcho(card: CardInstance): number {
  return Math.max(0, Math.trunc(flagsOf(card).echo ?? 0));
}

/**
 * R30: Twinspell grants Echo to the next Spell and "stays until a spell is played, then goes to the
 * GY". The grant is spent here — when it applies — and the Field Spell that gave it follows. Only a
 * Spell takes it ("the next Spell you play"), so a cast or played permanent leaves it armed, and
 * R70 makes a cast Spell take it like any other.
 */
export function grantedEcho(sink: EngineSink, player: PlayerId, card: CardInstance): number {
  const state = sink.state;
  if (defOf(state, card.defId).type !== "Spell") return 0;

  let granted = 0;
  const mods: PlayerModifier[] = [...state.players[player].mods];
  for (const mod of mods) {
    if (mod.kind !== "echoNextSpell" || !modifierIsLive(state, mod)) continue;
    granted += Math.max(0, mod.amount);
    removeModifier(sink, player, mod.id);

    const source = mod.sourceId === undefined ? undefined : findInstance(state, mod.sourceId);
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
 * Called exactly once per resolution — §10.5 step 6 guards it with the run's `echoQueued` flag and
 * `castCard` calls it on its way out — because it *consumes* the grant.
 */
export function queueEchoRepeats(sink: EngineSink, card: CardInstance, player: PlayerId): number {
  return addEchoRepeats(sink, card, player, printedEcho(card) + grantedEcho(sink, player, card));
}

// ---------------------------------------------------------------------------
// Where the card lands afterwards, and saying so (§10.5 step 7, R17)
// ---------------------------------------------------------------------------

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
export function landAfterResolution(sink: EngineSink, resolved: ResolvedCard): void {
  const state = sink.state;
  const card = findInstance(state, resolved.instanceId);

  if (card !== undefined && card.zone.z === "resolving" && moveToZone(state, card, "graveyard") === "moved") {
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
    permanent: findInstance(state, resolved.instanceId)?.zone.z === "field",
    costPaid: resolved.costPaid,
  });
}

// ---------------------------------------------------------------------------
// A cast's tail, owed to the pipeline driver (R70, R113)
// ---------------------------------------------------------------------------

/** `resume.hook` for the tail of a cast: §10.5 steps 6 to 8, run by `playSteps.ts`'s driver. */
export const CAST_TAIL_WORK = "castTail";

/** Where the plan sits inside `resume.data`, so the rest of `data` stays free. */
const CAST_KEY = "__cast";

/**
 * What the driver needs to finish a cast: which instance, whose it is, and the picks the caster
 * made, which a repeat asks again for itself (R81). All JSON, so a paused cast survives
 * `JSON.parse(JSON.stringify(state))` and replays exactly (§9.3, §10.1).
 */
export type CastTailPlan = {
  instanceId: string;
  defId: string;
  controller: PlayerId;
  targets: Selection[];
  modes: string[];
};

/** The owed continuation for a cast whose repeats are still to come (R70, R113). */
export function castTailResume(plan: CastTailPlan): Resume {
  return {
    defId: plan.defId,
    hook: CAST_TAIL_WORK,
    step: "echo",
    radiant: false,
    instanceId: plan.instanceId,
    data: { [CAST_KEY]: { ...plan } },
  };
}

/** The plan a continuation carries, or null when it is not one of ours. */
export function castTailOf(resume: { data: Record<string, unknown> }): CastTailPlan | null {
  const raw = resume.data[CAST_KEY];
  if (raw === null || typeof raw !== "object") return null;
  const plan = raw as Partial<CastTailPlan>;
  if (typeof plan.instanceId !== "string" || typeof plan.defId !== "string") return null;
  if (plan.controller !== "p1" && plan.controller !== "p2") return null;
  return {
    instanceId: plan.instanceId,
    defId: plan.defId,
    controller: plan.controller,
    targets: Array.isArray(plan.targets) ? plan.targets : [],
    modes: Array.isArray(plan.modes) ? plan.modes : [],
  };
}
