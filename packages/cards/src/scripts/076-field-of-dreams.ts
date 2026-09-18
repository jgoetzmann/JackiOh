// #76 Field of Dreams (SPEC §8.3, R31, R4, R11, R50, §10.5).
//
// Base: "Replace your hand with the same number of Reminisce; exile this". The radiant cell is
// "Radiant Reminisce", which restates only what the copies are, so every other clause is kept
// (§8 Conventions) and the two faces differ by one flag.
//
// R31 is the whole card: "Replaced cards go to the GY (ruling), so Reminisce can find them." So the
// replacement is a DISCARD of the whole hand, not an exile — the old hand lands in the graveyard,
// which is exactly the pool #72 Reminisce discovers from (R50 reads the actual graveyard, so the
// spell tokens among them are eligible too). A unit-token card in that hand ceases to exist instead
// of reaching the graveyard, which is `discard`'s own R11 rule and not this card's business.
//
// N is the hand size AT RESOLUTION. §10.5 step 4 has already moved Field of Dreams out of the hand
// into `resolving`, so it never counts itself, and the effects below are built before any of them
// applies — the count is taken before the hand is emptied. N = 0 (the last card in hand) discards
// nothing, adds nothing and still exiles this.
//
// The hand cap never bites here (R4): N ≤ HAND_CAP − 1 because Field of Dreams itself held a slot,
// and the N copies arrive into a hand the discard has just emptied, so nothing is ever burned.
// `addToHand` applies the cap regardless, so the rule is enforced either way.
//
// Missing verbs (see the report): `discardHand({ player })` — a deterministic whole-hand discard.
// `discardRandom({ count: N })` would be wrong, not merely ugly: it burns N rng draws to reach a
// deterministic outcome and so shifts `rngCursor`, which breaks replay parity (§9.3, §10.7).

import type { EffectContext, Script } from "@jackioh/engine";
import { zoneCount } from "@jackioh/engine";
import { addToHand, discardHand, exile } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-076");

/** R31: the card the hand is replaced with. Taken from the catalog, never restated here. */
const REMINISCE = cardDef("core-072").id;

/**
 * §10.9: a hook may READ state to compute an effect's arguments; it never writes. This is the only
 * read this card makes — N, the caller's hand size at resolution — and it goes through the engine's
 * read-only `zoneCount` (engine/src/query.ts), which is what keeps BUILD M3-T1's and REVIEW B1.7's
 * `state.players` grep over `src` clean.
 */
function handSizeOf(ctx: EffectContext): number {
  return zoneCount(ctx.state, ctx.controller, "hand");
}

/** The two faces differ only in whether the copies are Radiant (§5.2, R74). */
function fieldOfDreams(radiant: boolean): Script {
  return {
    cry: (ctx) => {
      const count = handSizeOf(ctx);
      return [
        // R31: the replaced hand goes to the graveyard, where Reminisce can find it.
        discardHand({ player: "self" }),
        ...Array.from({ length: count }, () => addToHand({ defId: REMINISCE, radiant })),
        // "exile this": the spell leaves from `resolving` and never reaches the graveyard.
        exile({ target: { of: "self" } }),
      ];
    },
  };
}

export const base: Script = fieldOfDreams(false);

export const radiant: Script = fieldOfDreams(true);
