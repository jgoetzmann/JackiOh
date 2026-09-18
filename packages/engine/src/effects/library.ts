// Exiling out of a library: the two halves of §6.3's Exile row that name a library rather than a
// target (#34 Collateral Damage, #40 Echoes of the Forgotten, #42 Eugenics, #65 Masochism Mask).
//
// `move.ts`'s `exile` takes a `TargetSpec`, which is how a card names a permanent or a card a prompt
// picked. A library card is neither: nobody chose it and nothing on the board points at it, so the
// two verbs below name it positionally instead — at random, or at the bottom of the pile.
//
// WHICH END IS THE TOP. `state.players[p].library[0]` is the TOP: `draw.ts`'s `drawOne` takes
// `side.library[0]` and splices it out, and `zones.ts`'s `moveToZone(state, card, "library")` with
// no position `unshift`s, i.e. puts a card back on top, while `position: "bottom"` splices at
// `pile.length`. So the BOTTOM card of a library is its LAST element, `library[library.length - 1]`.
// This comment exists because getting it backwards is silent: the game plays on, #40 eats the wrong
// end of the deck, and no test that only counts cards would notice.

import type { Effect, EffectContext } from "../script";
import type { CardInstance } from "../state";
import { moveToZone } from "../zones";
import { playerOf, type PlayerSpec } from "./targets";

/**
 * One card to the exile pile, exactly as `move.ts`'s `exile` does it: the game exile counter counts
 * only the cards that actually get there, a unit-token library card ceases to exist instead and is
 * not counted (R11 — §3.2 names Infinite Reserves and the Unstable Clone Machine / Recycling
 * Initiative / Combo-Index copies as the cards that can be in a library at all), and the `exiled`
 * event reports the card leaving either way so §10.10 can animate it.
 *
 * §6.3's Exile row gives no Death trigger, so nothing is dispatched here.
 */
function exileCard(ctx: EffectContext, card: CardInstance): void {
  const moved = moveToZone(ctx.state, card, "exile");
  if (moved === "moved") ctx.state.counters.exiled += 1;
  ctx.events.push({
    type: "exiled",
    instanceId: card.id,
    defId: card.defId,
    owner: card.owner,
  });
}

/**
 * §6.3 Exile, `count` random cards out of a library: #34 Collateral Damage's "a random card from the
 * opponent's library", #42 Eugenics' "Exile 8 random cards from your library".
 *
 * The cards are DISTINCT. R60 rules that "a random pick of N existing cards picks N different cards,
 * or all of them if fewer exist", and #42's engine cell says "Fewer than 8 → exile all" — so fewer
 * than `count` in the library exiles the whole library rather than drawing the short end twice.
 * `ctx.rng.shuffle(library).slice(0, count)` is the deterministic form of both: `shuffle` copies the
 * list before its Fisher-Yates walk, so the picks depend on nothing but (seed, cursor) and the loop
 * may empty the real library underneath it.
 *
 * An empty library fizzles and the card still resolves (§6.3). No draw happens, so no fatigue.
 */
export function exileRandomFromLibrary(args: { count?: number; player?: PlayerSpec } = {}): Effect {
  return {
    kind: "exileRandomFromLibrary",
    apply(ctx): void {
      const player = playerOf(ctx, args.player ?? "self");
      const library = ctx.state.players[player].library;
      const count = Math.max(0, Math.trunc(args.count ?? 1));
      if (count === 0 || library.length === 0) return;

      for (const card of ctx.rng.shuffle(library).slice(0, count)) exileCard(ctx, card);
    },
  };
}

/**
 * §6.3 Exile, the BOTTOM card of a library: #40 Echoes of the Forgotten's "then exile the bottom
 * card of your library" and #65 Masochism Mask's "exile the bottom card of your library". The bottom
 * is the last element — see the module header for how that was verified against `drawOne`.
 *
 * #40's engine cell: "empty library → no exile, no fatigue". So an empty library does nothing at
 * all: this verb never reaches `draw.ts`, so §2.4's fatigue clock is untouched and `fatigueCount`
 * does not move. Fatigue is the price of a DRAW from an empty library, and this is not a draw.
 *
 * `count` is here for a card that takes more than one; each iteration re-reads the pile, so exiling
 * the bottom twice takes the bottom two cards bottom-upward and stops early on an empty library.
 */
export function exileBottomOfLibrary(args: { player?: PlayerSpec; count?: number } = {}): Effect {
  return {
    kind: "exileBottomOfLibrary",
    apply(ctx): void {
      const player = playerOf(ctx, args.player ?? "self");
      const count = Math.max(0, Math.trunc(args.count ?? 1));

      for (let i = 0; i < count; i += 1) {
        const library = ctx.state.players[player].library;
        const card = library[library.length - 1];
        if (card === undefined) return;
        exileCard(ctx, card);
      }
    },
  };
}
