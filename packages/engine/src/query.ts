// The read-only board queries a card script asks its questions with (BUILD M3-T1, SPEC §10.9).
//
// §10.9 lets a hook READ state to compute an effect's arguments and forbids it writing; BUILD M3-T1
// asks, more strictly, that `grep -r "state.players[" packages/cards` come back empty. A raw
// `ctx.state.players[…]` read satisfies the spec and fails the acceptance grep, and the grep is
// right for a reason the spec does not state: fifteen card files spelling out the shape of
// `PlayerState` means `PlayerState` cannot change shape without editing fifteen card files. This
// module is the fix — the read half of the card-facing surface, next to `src/effects/index.ts`,
// which is the write half.
//
// So: a verb a card needs lives in `src/effects`; a FACT a card needs lives here. The existing
// readers a card file already imports off the root index stay where they are and are part of the
// same surface — `activeUnitsOf`, `dormantUnitsOf`, `cardAt`, `slotsOf`, `slotOf` (`zones.ts`, which
// owns the field because it owns the lanes), `faceOf`, `statsWithBuffs` (`layers.ts`, §10.4),
// `defOf` (`catalog.ts`), `findInstance` (`state.ts`). What had no home was everything ABOUT a
// player rather than about a card or a lane: the hero block, the off-field piles and the turn log.
//
// Why a module of its own rather than more of `zones.ts`: `zones.ts` is a mutator module — it owns
// `placeOnField`, `moveToZone`, `lockZone`, `resetInstance` — and its readers are there because
// they read the thing it writes. The hero block and the turn log are not zones at all, and putting
// a read-only surface among the writers hides the one property that makes it a surface: nothing
// here can change the game. Every function below takes `(state, player, …)`, returns numbers,
// booleans or a fresh `readonly` array, and holds no reference the caller can write through.
//
// NAMING: `catalog.ts` owns the CARD-POOL query of §5.1 (`catalog.query`, wrapped for cards by
// `packages/cards/src/query.ts`). This module queries the BOARD. Two different questions; the
// names below say which is which, and neither exports a bare `query`.

import type { PlayerId } from "@jackioh/shared";
import type { EffectContext } from "./script";
import { findInstance, type CardInstance, type GameState } from "./state";
import { partMemoryKey } from "./work";
import type { OffFieldZone } from "./zones";

/**
 * A hero's block as a card may see it: §10.1's `{ health, armor }`, copied, so a script cannot
 * write a hero's health by assigning through the result (which the acceptance grep could not catch
 * and `stateCheck` would then disagree with).
 */
export type HeroView = { readonly health: number; readonly armor: number };

/**
 * §10.1's hero block for one player. `health` is the current total that §4.4 damages and §2.6 reads
 * for the loss check; `armor` is the stored field §4.4 step 2 subtracts, not a computed total, so a
 * card that wants "the Armor this hero has right now" wants the damage pipeline's own reader and
 * not this (#73, #84).
 */
export function heroOf(state: GameState, player: PlayerId): HeroView {
  const hero = state.players[player].hero;
  return { health: hero.health, armor: hero.armor };
}

/**
 * The live pile, for this module's own use only. The zone -> pile mapping is `zones.ts`'s
 * (`pileFor`), which is private there because handing a card file a live `CardInstance[]` hands it
 * a `push` into a zone; every export below copies before it returns.
 */
function pileOf(state: GameState, player: PlayerId, zone: OffFieldZone): readonly CardInstance[] {
  const side = state.players[player];
  if (zone === "hand") return side.hand;
  if (zone === "library") return side.library;
  if (zone === "graveyard") return side.graveyard;
  return side.exile;
}

/**
 * One of a player's off-field piles, in zone order, as a copy: `library[0]` is the top (the next
 * card drawn, `draw.ts`), a hand and a graveyard are in arrival order, and an exile pile is in
 * exile order (§3). The field is not a pile — `activeUnitsOf`, `dormantUnitsOf` and `cardAt` read
 * the lanes, because R13 makes the top of a Stack the only card that acts.
 *
 * The array is fresh and `readonly`, so iterating it is safe while the effects it builds resolve
 * and mutate the real pile (#83 replaces every card in three of them).
 */
export function zoneCards(
  state: GameState,
  player: PlayerId,
  zone: OffFieldZone,
): readonly CardInstance[] {
  return [...pileOf(state, player, zone)];
}

/** How many cards are in one of a player's off-field piles (§3). */
export function zoneCount(state: GameState, player: PlayerId, zone: OffFieldZone): number {
  return pileOf(state, player, zone).length;
}

/**
 * §10.5 step 4's count of the cards this player has played this turn, cleared by `startTurn`.
 * The card being played is already counted when its own script and any `cardPlayed` trigger run —
 * §6.2's Combo X reads "played EARLIER this turn", so a card counting the plays before itself
 * subtracts one (#38).
 */
export function cardsPlayedThisTurn(state: GameState, player: PlayerId): number {
  return state.players[player].turnLog.cardsPlayed;
}

/**
 * The instance ids this player has played this turn, in play order, as a copy. The ids are enough
 * to name the cards: `findInstance` turns one into its instance wherever it has landed since (R98).
 */
export function playedIdsThisTurn(state: GameState, player: PlayerId): readonly string[] {
  return [...state.players[player].turnLog.playedIds];
}

/**
 * §6.2 Combo X: how many cards this player played earlier this turn than this card's play — its
 * place in the turn's log, which §10.5 step 4 wrote as it played the card ("`turnLog.cardsPlayed`
 * checked at play time", §8 #10). A card the play itself goes on to cast (a cast-on-draw card that
 * /fullsend's Combo draw takes at step 5, R70) is played after it, never earlier, so the count does
 * not move while the play resolves. A card played twice this turn is counted from its latest play.
 * A card still in a hand, or one the log does not hold, has not been played: every play this turn
 * is earlier than the one it would be. `null` is a script running with no instance (`ctx.self` of a
 * card that has ceased to exist, R127): its play is taken as the latest one in the log, so every
 * play but that one is earlier.
 */
export function playedEarlier(state: GameState, player: PlayerId, card: CardInstance | string | null): number {
  const log = state.players[player].turnLog;
  if (card === null) return Math.max(0, log.cardsPlayed - 1);
  const id = typeof card === "string" ? card : card.id;
  const instance = typeof card === "string" ? findInstance(state, card) : card;
  if (instance?.zone.z === "hand") return log.cardsPlayed;
  const at = log.playedIds.lastIndexOf(id);
  return at >= 0 ? at : log.cardsPlayed;
}

/**
 * Whether this player played this card this turn — the one-shot gate §5.1's "End of turn: add this
 * back to your hand" spells need (#23, #24, #31, R68): the card returns on the turn it was played
 * and not at every end of turn thereafter, and a copy that reached the graveyard by being discarded
 * or milled was never played and stays there. `player` is explicit because a card's owner and its
 * controller can differ and each card says which log it means.
 */
export function wasPlayedThisTurn(
  state: GameState,
  player: PlayerId,
  card: CardInstance | string,
): boolean {
  const id = typeof card === "string" ? card : card.id;
  return state.players[player].turnLog.playedIds.includes(id);
}

/**
 * What the card running a script remembers under `key` (§10.1: #22 Carnivorous Cube's meal), read
 * the way `effects/memory.remember` wrote it. On a fused card each ingredient remembers apart (R102),
 * so an ingredient reads its own first — two Cubes crafted into one card copy two meals — and then
 * what the card remembered before the Fuse kept it (R77 keeps the target's memory). The value is
 * handed back as stored, JSON, for the card to read defensively.
 */
export function recalled(ctx: Pick<EffectContext, "self" | "data">, key: string): unknown {
  const memory = ctx.self?.memory;
  if (memory === undefined) return undefined;
  const own = memory[partMemoryKey(ctx.data, key)];
  return own !== undefined ? own : memory[key];
}
