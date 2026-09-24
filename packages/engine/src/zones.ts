// Zones, lanes, adjacency, the two rotation rings, locks and Stack piles (SPEC §3).
// These are the only places a card changes zone; effects (M3-T1) call them and emit the events.

import type { PlayerId, Row, Zone } from "@jackioh/shared";
import { PLAYER_IDS, opponentOf } from "@jackioh/shared";
import { BACKROW_ZONES, UNIT_ZONES } from "./config";
import { defOf } from "./catalog";
import type { CardInstance, GameState, Pile, PlayerState } from "./state";
import { noteFieldExit, noteMoved, noteUncovered } from "./stays";

export type ZoneSlot = { player: PlayerId; row: Row; lane: number };

export function rowSize(row: Row): number {
  return row === "units" ? UNIT_ZONES : BACKROW_ZONES;
}

export function slotsOf(player: PlayerId, row: Row): ZoneSlot[] {
  return Array.from({ length: rowSize(row) }, (_, i) => ({ player, row, lane: i + 1 }));
}

/** §3.1: lane N-1 and N+1 on the same side and row, never across sides. */
export function adjacent(ref: ZoneSlot): ZoneSlot[] {
  const size = rowSize(ref.row);
  return [ref.lane - 1, ref.lane + 1]
    .filter((lane) => lane >= 1 && lane <= size)
    .map((lane) => ({ player: ref.player, row: ref.row, lane }));
}

/**
 * R14: one ring per row. From the rotating player's seat it runs their lane 1 to 5, then the
 * opponent's lane 5 down to 1, and back. "Right" is one step forward along that order.
 */
export function ringOrder(row: Row, perspective: PlayerId): ZoneSlot[] {
  const size = rowSize(row);
  const mine = Array.from({ length: size }, (_, i) => ({ player: perspective, row, lane: i + 1 }));
  const theirs = Array.from({ length: size }, (_, i) => ({
    player: opponentOf(perspective),
    row,
    lane: size - i,
  }));
  return [...mine, ...theirs];
}

export function ringNeighbor(ref: ZoneSlot, direction: "left" | "right", perspective: PlayerId): ZoneSlot {
  const ring = ringOrder(ref.row, perspective);
  const at = ring.findIndex((slot) => slot.player === ref.player && slot.lane === ref.lane);
  if (at < 0) throw new Error(`zone not on the ${ref.row} ring: ${ref.player} lane ${ref.lane}`);
  const step = direction === "right" ? 1 : -1;
  const next = ring[(at + step + ring.length) % ring.length];
  if (next === undefined) throw new Error("ring index out of range");
  return next;
}

export function isLocked(state: GameState, ref: ZoneSlot): boolean {
  return state.players[ref.player].locks[ref.row][ref.lane - 1] === true;
}

export function lockZone(state: GameState, ref: ZoneSlot): void {
  state.players[ref.player].locks[ref.row][ref.lane - 1] = true;
}

export function pileAt(state: GameState, ref: ZoneSlot): Pile | null {
  if (ref.row !== "units") throw new Error("piles exist in the unit row only");
  return state.players[ref.player].units[ref.lane - 1] ?? null;
}

/** The card that acts in this zone: the top of a Stack pile, or the backrow card (§3.2). */
export function cardAt(state: GameState, ref: ZoneSlot): CardInstance | null {
  if (ref.row === "units") return pileAt(state, ref)?.[0] ?? null;
  return state.players[ref.player].backrow[ref.lane - 1] ?? null;
}

export function isEmpty(state: GameState, ref: ZoneSlot): boolean {
  return cardAt(state, ref) === null;
}

/** A zone that accepts a summon: empty and unlocked (§3.2). */
export function isOpen(state: GameState, ref: ZoneSlot): boolean {
  return isEmpty(state, ref) && !isLocked(state, ref) && !isReserved(state, ref);
}

/** R64: a dying Reborn unit holds its zone until it comes back. */
export function isReserved(state: GameState, ref: ZoneSlot): boolean {
  return state.reserved.some((r) => r.player === ref.player && r.row === ref.row && r.lane === ref.lane);
}

export function reserveZone(state: GameState, ref: ZoneSlot): void {
  if (!isReserved(state, ref)) state.reserved.push({ ...ref });
}

export function releaseZone(state: GameState, ref: ZoneSlot): void {
  state.reserved = state.reserved.filter(
    (r) => !(r.player === ref.player && r.row === ref.row && r.lane === ref.lane),
  );
}

export function openZones(state: GameState, player: PlayerId, row: Row): ZoneSlot[] {
  return slotsOf(player, row).filter((ref) => isOpen(state, ref));
}

/** R64: the leftmost open zone, or null when the row is full. */
export function firstFreeZone(state: GameState, player: PlayerId, row: Row): ZoneSlot | null {
  return openZones(state, player, row)[0] ?? null;
}

export function zoneOf(ref: ZoneSlot): Zone {
  return { z: "field", player: ref.player, row: ref.row, lane: ref.lane };
}

/** True when this def is a unit token, which ceases to exist off the field (R11). */
export function isUnitToken(state: GameState, instance: CardInstance): boolean {
  const def = defOf(state, instance.defId);
  return def.token && def.type === "Unit";
}

/**
 * Put a card on the field. A Stack card may enter an occupied unit zone and becomes the top of the
 * pile; the card beneath keeps its damage and stops acting (§3.2). Returns false when the zone
 * cannot take it, leaving the state untouched.
 */
export function placeOnField(
  state: GameState,
  instance: CardInstance,
  ref: ZoneSlot,
  options: { stack?: boolean } = {},
): boolean {
  if (isLocked(state, ref)) return false;
  if (isReserved(state, ref)) return false;
  const side = state.players[ref.player];

  if (ref.row === "units") {
    const existing = side.units[ref.lane - 1] ?? null;
    if (existing !== null && options.stack !== true) return false;
    side.units[ref.lane - 1] = existing === null ? [instance] : [instance, ...existing];
  } else {
    if (side.backrow[ref.lane - 1] != null) return false;
    side.backrow[ref.lane - 1] = instance;
  }

  instance.controller = ref.player;
  instance.zone = zoneOf(ref);
  if (ref.row === "units") instance.position ??= "ATK";
  return true;
}

/**
 * R227: whether a card placed in this row lands face-down — a Trap or a Field Trap in a backrow
 * (§3.2, R33). A Field Spell lands face-up, and a Unit never reaches the backrow.
 */
export function landsFaceDown(state: GameState, instance: CardInstance, row: Row): boolean {
  if (row !== "backrow") return false;
  const type = defOf(state, instance.defId).type;
  return type === "Trap" || type === "Field Trap";
}

/**
 * R227: a card going face-down takes a fresh instance id, so the one handle the action protocol has
 * for a face-down card — a play's target, a prompt option's answer (R177) — is an id no player has
 * seen before, and an id seen while the card was public never names it again. The id is the next
 * number, as a new card's is; whether a card goes face-down is public (§10.8 shows the zone
 * occupied), so the number it takes says nothing either. Called on a card that is in no pile, just
 * before it is placed. Returns the id the card had, which the `cardPlayed` or `summoned` that
 * places it carries as `formerId` for the views to follow (R97).
 */
export function freshFaceDownId(state: GameState, instance: CardInstance): string {
  const former = instance.id;
  instance.id = `c${state.nextId}`;
  state.nextId += 1;
  return former;
}

/**
 * §6.3 Replace on the field: the new card takes the old one's place — the same zone, and the same
 * place in a Stack pile — under the same controller. That is no summon, so §3.2's Lock ("the zone
 * accepts no summons … the current occupant is unaffected") and R64's reservation do not refuse it:
 * the zone was occupied before and is occupied after. Returns false, changing nothing, when the old
 * card is not on the field. The old card is left pointing at its zone for the caller to retire.
 */
export function replaceInZone(state: GameState, old: CardInstance, replacement: CardInstance): boolean {
  const zone = old.zone;
  if (zone.z !== "field") return false;
  const side = state.players[zone.player];
  if (zone.row === "units") {
    const pile = side.units[zone.lane - 1] ?? null;
    if (pile === null || !pile.some((card) => card.id === old.id)) return false;
    side.units[zone.lane - 1] = pile.map((card) => (card.id === old.id ? replacement : card));
  } else {
    if (side.backrow[zone.lane - 1]?.id !== old.id) return false;
    side.backrow[zone.lane - 1] = replacement;
  }
  replacement.controller = zone.player;
  replacement.zone = { ...zone };
  if (zone.row === "units") replacement.position ??= "ATK";
  return true;
}

/**
 * Take a card off the field; the card beneath a Stack resumes acting (§3.2), which is noted against
 * the card that left (`stays.noteUncovered`, R212): no event reports a resume. `withPile` is for a
 * move that lifts whole piles and sets each down whole elsewhere (#87's board swap, #52's rotation):
 * its cards come off one at a time, but nothing beneath any of them resumes, so no resume is noted.
 */
export function removeFromField(
  state: GameState,
  instance: CardInstance,
  options: { withPile?: boolean } = {},
): boolean {
  for (const player of PLAYER_IDS) {
    const side = state.players[player];
    for (let i = 0; i < side.units.length; i += 1) {
      const pile = side.units[i] ?? null;
      if (pile === null) continue;
      const at = pile.findIndex((card) => card.id === instance.id);
      if (at >= 0) {
        const rest = pile.filter((card) => card.id !== instance.id);
        side.units[i] = rest.length === 0 ? null : rest;
        noteUncovered(state, instance.id, at === 0 && options.withPile !== true ? rest[0]?.id : undefined);
        return true;
      }
    }
    for (let i = 0; i < side.backrow.length; i += 1) {
      if (side.backrow[i]?.id === instance.id) {
        side.backrow[i] = null;
        return true;
      }
    }
  }
  return false;
}

export type OffFieldZone = "hand" | "library" | "graveyard" | "exile";

/** The pile a card lands in; off the field it always belongs to its owner (R12). */
function pileFor(side: PlayerState, zone: OffFieldZone): CardInstance[] {
  if (zone === "hand") return side.hand;
  if (zone === "library") return side.library;
  if (zone === "graveyard") return side.graveyard;
  return side.exile;
}

export function removeFromAnyZone(state: GameState, instance: CardInstance): void {
  if (removeFromField(state, instance)) return;
  for (const player of PLAYER_IDS) {
    const side = state.players[player];
    for (const zone of ["hand", "library", "graveyard", "exile"] as const) {
      const pile = pileFor(side, zone);
      const at = pile.findIndex((card) => card.id === instance.id);
      if (at >= 0) {
        pile.splice(at, 1);
        // R212: a move of a card that left a pile's top ends that removal's Stack note.
        noteMoved(state, instance.id);
        // R155: §5.1's end-of-turn return belongs to the Spell its own play landed in the graveyard
        // (§10.5 step 7). A card that leaves the graveyard has spent that landing, so whatever puts
        // it back there this turn — a discard (#76), a burn — is no play of its, and it stays (R153).
        if (zone === "graveyard") delete instance.returnToHandAtEndOfTurn;
        return;
      }
    }
    // §10.5 step 4 parks a card here between its play and its destination. Without this a Spell
    // moved from `resolving` to the graveyard would be left in both piles, i.e. two live copies
    // of one instance — so the resolving pile is searched like any other.
    const resolvingAt = side.resolving.findIndex((card) => card.id === instance.id);
    if (resolvingAt >= 0) {
      side.resolving.splice(resolvingAt, 1);
      noteMoved(state, instance.id);
      return;
    }
  }
}

/**
 * R78: leaving the field resets an instance, while costMod, costOverride and radiant persist. R215
 * applies the same reset to a hand or library card that reaches a graveyard or exile, and to a card
 * leaving the resolving zone once its play is over.
 */
export function resetInstance(instance: CardInstance): void {
  instance.damage = 0;
  instance.buffs = { attack: 0, health: 0 };
  instance.grantedKeywords = [];
  instance.vanilla = false;
  instance.counters = {};
  instance.memory = {};
  instance.exertion = { attacked: false, switched: false };
  instance.controller = instance.owner;
  delete instance.position;
  delete instance.summonedTurn;
  delete instance.statsOverride;
  delete instance.armorOverride;
  delete instance.tauntSuppressedTurn;
  delete instance.faceUp;
  delete instance.lastDamagedBy;
  delete instance.x;
  delete instance.embiggened;
  delete instance.divineShieldSpent;
  delete instance.markedDestroyed;
  delete instance.rebornSpent;
}

/**
 * R174: drop the delayed effects aimed at a card that is leaving the field (`DelayedEffect.watch`).
 * The card that may later stand in the same zone under the same id — bounced and replayed, or back
 * through Reborn — is a new arrival (R78, R83), and an effect aimed at the old one fizzles (R76).
 */
function forgetWatchers(state: GameState, instanceId: string): void {
  if (!state.delayed.some((effect) => effect.watch === instanceId)) return;
  state.delayed = state.delayed.filter((effect) => effect.watch !== instanceId);
}

/** The zones a queue entry names when the card answered from the field (`triggers.queueTrigger`). */
const FIELD_TRIGGER_ZONES: readonly unknown[] = ["field", "backrow"];

/**
 * R174: drop the triggers and turn hooks this card queued while it stood on the field. They belong
 * to that stay: a Reborn body or a replayed card under the same id is a reset instance that has
 * entered the field again (R78, R83), so an entry queued before it left — #91's Plague Token for the
 * hit that killed it, #37's start-of-turn hook queued before it died — never acts on what came
 * back. Without Reborn the entry already fizzled, because a card in a graveyard answers none of
 * its field triggers (R153); this makes the card that returns answer none of them either.
 */
function forgetQueuedTriggers(state: GameState, instanceId: string): void {
  const owned = (entry: GameState["triggerQueue"][number]): boolean =>
    entry.instanceId === instanceId && FIELD_TRIGGER_ZONES.includes(entry.resume.data.zone);
  if (!state.triggerQueue.some(owned)) return;
  state.triggerQueue = state.triggerQueue.filter((entry) => !owned(entry));
}

/**
 * R86: a card ceases to exist — replaced by a Transform (R35), fused away (R77), or a unit token
 * leaving the field (R11) — and is in no pile afterwards, which is the `{ z: "gone" }` zone. One
 * that ceases to exist ON the field has left it, as a destroyed or bounced card has (R174): the
 * departure is counted, so a trap later in the same dispatch meets a play the first Sheepish turned
 * into a Sheep as a card no longer in play (`traps.standingEvent`), and the delayed effects and
 * queued triggers aimed at that stay end with it, as `moveToZone` ends them for a card that lands.
 */
export function ceaseToExist(state: GameState, instance: CardInstance): void {
  const wasOnField = instance.zone.z === "field";
  removeFromAnyZone(state, instance);
  if (wasOnField) {
    noteFieldExit(state, instance.id);
    forgetWatchers(state, instance.id);
    forgetQueuedTriggers(state, instance.id);
  }
  instance.zone = { z: "gone", player: instance.owner };
}

/**
 * §2.3: X and the embiggen price are chosen at play time and stored on the played instance, and
 * R65 has an X-cost card cost 0 and an embiggen card its base price everywhere outside play. So the
 * choice ends with the play: a Spell that leaves the resolving zone (to its graveyard, to exile, or
 * straight to a hand) drops it, as R78's reset drops it from a permanent leaving the field. Without
 * this #24 Efficiency Dividend returned to hand at the X it was last played for.
 */
function endPlayChoices(instance: CardInstance): void {
  delete instance.x;
  delete instance.embiggened;
}

export type MoveResult = "moved" | "vanished";

/**
 * Move a card to one of its owner's off-field zones. Unit tokens cease to exist instead (R11),
 * and a unit-token card leaving hand or library other than by being drawn or played does too.
 *
 * R151's arrival hook is deliberately NOT here, although this is the single point every zone change
 * goes through: the roll a card makes as it arrives needs the match rng, and this function takes a
 * `GameState`, which holds only the seed and the cursor `reduce` stores between actions. Building an
 * rng from those mid-action would repeat draws the action's own rng has already taken and would have
 * its advanced cursor thrown away by `reduce`'s `next.rngCursor = sink.rng.cursor`. The hook lives
 * one layer up, on the sink-holding funnels every hand and library arrival passes through —
 * `draw.addToHand` and `draw.shuffleIntoLibrary` (`runArrivalHooks` in `draw.ts`).
 */
export function moveToZone(
  state: GameState,
  instance: CardInstance,
  zone: OffFieldZone,
  options: { position?: "top" | "bottom" | number; keepState?: boolean } = {},
): MoveResult {
  const from = instance.zone.z;
  const wasOnField = from === "field";
  const token = isUnitToken(state, instance);
  removeFromAnyZone(state, instance);
  // R174: leaving the field ends every delayed effect aimed at this card and every trigger it
  // queued there, whatever comes back, and ends the stay every effect aimed at it was aimed at.
  if (wasOnField) {
    noteFieldExit(state, instance.id);
    forgetWatchers(state, instance.id);
    forgetQueuedTriggers(state, instance.id);
  }
  if (from === "resolving") endPlayChoices(instance);

  // R11: a unit token ceases to exist when it leaves the field, and a unit-token card ceases to
  // exist when it would reach a graveyard or exile. One may live in a hand or library (#75) and
  // "ceases to exist if it leaves that zone other than by being drawn or played, burning
  // included" — a draw is this call moving it from the library to the hand, and a play never comes
  // through here (`playSteps` puts the card on the field or in `resolving` itself), so every other
  // move out of a hand or a library ends it: discarded, exiled, burned, shuffled back.
  // Staying put is not leaving, so a copy shuffled into the library it was made in lives (R34).
  const leftHandOrLibrary =
    (from === "hand" || from === "library") && zone !== from && !(from === "library" && zone === "hand");
  if (
    token &&
    (wasOnField || from === "resolving" || zone === "graveyard" || zone === "exile" || leftHandOrLibrary)
  ) {
    // R86: it ceased to exist, so it goes to "gone" rather than looking like an exiled card.
    instance.zone = { z: "gone", player: instance.owner };
    return "vanished";
  }

  // R215: a card that reaches a graveyard or an exile pile from a hand or a library is reset too, so
  // what comes back from there is the printed card (#89's hand buffs, #98's rolled power, R151) —
  // R78's reset, with `costMod`, `costOverride` and `radiant` kept in every zone as R78 keeps them.
  // So is a card that lands from the resolving zone (§10.5 step 7): its play is over, and a #95 an
  // earlier Call to Chaos cast (R87) carries no link of that chain (R28) back into a play of its own.
  const pileToPile = (from === "hand" || from === "library") && (zone === "graveyard" || zone === "exile");
  const landed = from === "resolving";
  if ((wasOnField || pileToPile || landed) && options.keepState !== true) resetInstance(instance);

  const side = state.players[instance.owner];
  const pile = pileFor(side, zone);
  const at = options.position;
  if (zone === "library" && at !== undefined && at !== "top") {
    const index = at === "bottom" ? pile.length : Math.max(0, Math.min(pile.length, at));
    pile.splice(index, 0, instance);
  } else if (zone === "library") {
    pile.unshift(instance);
  } else {
    pile.push(instance);
  }
  instance.zone = { z: zone, player: instance.owner };
  return "moved";
}

/** Every card that acts for this player, in lane order (§3.2). */
export function activeUnitsOf(state: GameState, player: PlayerId): CardInstance[] {
  return slotsOf(player, "units").flatMap((ref) => {
    const card = cardAt(state, ref);
    return card === null ? [] : [card];
  });
}

export function dormantUnitsOf(state: GameState, player: PlayerId): CardInstance[] {
  return state.players[player].units.flatMap((pile) => (pile ?? []).slice(1));
}

/**
 * §3.2, R13: a card dormant under a Stack pile — in a unit zone and not the top of its pile. It is
 * "not on the field for effects": nothing targets it, and an effect aimed at it fizzles (R174).
 */
export function isBuried(state: GameState, instance: CardInstance): boolean {
  const zone = instance.zone;
  if (zone.z !== "field" || zone.row !== "units") return false;
  return cardAt(state, { player: zone.player, row: zone.row, lane: zone.lane })?.id !== instance.id;
}

/**
 * R64: "fill your board" takes every empty, unlocked unit zone, left to right. The caller makes
 * each card; this returns the zones to fill, in order.
 */
export function fillBoardZones(state: GameState, player: PlayerId): ZoneSlot[] {
  return openZones(state, player, "units");
}

export function slotOf(state: GameState, instance: CardInstance): ZoneSlot | null {
  const zone = instance.zone;
  if (zone.z !== "field") return null;
  return { player: zone.player, row: zone.row, lane: zone.lane };
}
