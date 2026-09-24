// #30 Archivist (SPEC §8.2): "Cry: choose one: draw the highest-cost card in your library, or the
// lowest", radiant "Cry: draw both". The radiant cell restates the whole Cry, so it replaces the
// base clause (§8 Conventions) — the radiant face asks nothing and takes both cards.
//
// The mode is a DECLARED play-time choice, so it travels in the play action's `modes` and never
// pauses resolution (R81); `chosenOptions` reads it back out of the context. The radiant face
// declares no modes, because it has nothing left to ask.
//
// R24: highest and lowest are read with costs per R65, so an X-cost card in a library counts 0 and
// an embiggen card counts its base price, and ties go to the card nearest the top. `library[0]` is
// the top (engine/src/draw.ts draws it), so scanning top down and keeping only a STRICTLY better
// cost keeps the first card seen, which is the one nearest the top. The cost function is
// `mana.effectiveCost`, the one R65 calculation for an instance: it starts from `costOverride` or
// the printed cost and adds the instance's `costMod` (which persists in every zone, R78). The
// player's discounts price a play from the hand and never a library card (R65), so Professor
// Curvature's or Lunar Eclipse's discount does not make a 4 in the library a 3 that ties with a 3
// above it. For a library card the printed cost is already R65's out-of-play number,
// since a card that was never played has no `x` and is not `embiggened`. `queryCost` is the other
// half of R65 and is the wrong one here: it reads a DEFINITION, so it cannot see the `costMod` #7
// Jewelosco Scarab left on the instance or the discount #95 Call to Chaos put on the library, and
// BUILD M4-T4 asks for "current cost".
//
// An empty library draws nothing and the Cry fizzles; the unit still enters (§8 Conventions). With
// exactly one card in the library that card is both the highest and the lowest, so the radiant face
// draws it once — `setRadiant`-style de-duplication is not needed because the two picks are
// compared by instance before the second draw is emitted.
//
// The draw is §6.3's Draw of a card the script named, `drawFromLibrary` (#94 Genn's Greed uses it
// too): the library card itself leaves the library as a draw — a `drawn` event, R55's counter, the
// hand cap (R4) and the cast-on-draw path (§2.4, R58) — rather than a fresh copy landing in hand.

import type { CardInstance, Effect, EffectContext, Script } from "@jackioh/engine";
import { effectiveCost, zoneCards } from "@jackioh/engine";
import { chosenOptions, drawFromLibrary, forEachCard } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-030");

/** §8.2's two modes, as the play action spells them (R81). */
const HIGHEST = "highest";
const LOWEST = "lowest";

/**
 * R24: the library card with the extreme current cost, ties going to the card nearest the top.
 * Reading state to name a card is not mutation; nothing here writes (CLAUDE.md rule 5), and the
 * read is `zoneCards` (engine/src/query.ts), which gives the pile top-first as a copy — so this
 * file never names a field of `PlayerState` (BUILD M3-T1).
 */
function extreme(ctx: EffectContext, want: typeof HIGHEST | typeof LOWEST): CardInstance | null {
  let best: CardInstance | null = null;
  let bestCost = 0;
  for (const card of zoneCards(ctx.state, ctx.controller, "library")) {
    const cost = effectiveCost(ctx.state, card);
    const better = want === HIGHEST ? cost > bestCost : cost < bestCost;
    // Strict, and top down, so a tie keeps the card already held — the one nearer the top (R24).
    if (best === null || better) {
      best = card;
      bestCost = cost;
    }
  }
  return best;
}

/** §6.3 Draw of one named library card (R24), or nothing for an empty library. */
function drawNamed(card: CardInstance | null): Effect[] {
  return card === null ? [] : [drawFromLibrary({ instanceId: card.id })];
}

export const base: Script = {
  modes: [{ kind: "mode", options: [HIGHEST, LOWEST] }],
  cry: (ctx) => {
    // R81: the mode arrived with the play, so there is nothing to wait for. R90 validates the
    // declaration, so anything else means no mode was carried at all — fizzle rather than guess.
    const mode = chosenOptions(ctx)[0];
    if (mode !== HIGHEST && mode !== LOWEST) return [];
    return drawNamed(extreme(ctx, mode));
  },
};

export const radiant: Script = {
  cry: () => {
    // A one-card library is its own highest and lowest, so "draw both" draws it once.
    // The two are read once, as the Cry begins: a highest card that is cast on draw and asks has left
    // the library by the answer, and a rebuilt pair would name other cards (R113, `forEachCard`).
    return [
      forEachCard({
        cards: (at) => {
          const high = extreme(at, HIGHEST);
          const low = extreme(at, LOWEST);
          const both = high !== null && high.id === low?.id ? [high] : [high, low];
          return both.flatMap((card) => (card === null ? [] : [card]));
        },
        each: (instanceId) => drawFromLibrary({ instanceId }),
      }),
    ];
  },
};
