// #95 Call to Chaos (Core Edition) (SPEC §8.4, R28, R58, R60, R70, R87, BUILD M4-T4 row 95).
//
// Base: "One random effect" out of ten. Radiant: "Two random effects: 'cast a random Call to Chaos'
// plus one drawn from the other 9" (R28) — the recursion is guaranteed and never doubled.
//
// The whole card is `engine/src/subsystems/callToChaos.ts`, whose header names this file's shape:
// "#95's own file (M4) is a one-line hook that returns `[callToChaos()]`". The subsystem owns the
// ten effects, the roll and the chain counter, for reasons that are all engine concerns:
//   * each effect must read the board when it RESOLVES, not when the hook builds it, because the
//     radiant pair resolves the recursion and its whole chain first (R87) and a nested cast draws
//     cards, summons units and changes costs in between. Every effect there is a lazy wrapper.
//   * the chain length is game state, on the cast instance's `memory` (§10.1,
//     `CHAOS_CHAIN_KEY`), so a paused and serialized game resumes with the same cap left and two
//     independent Calls in one turn never share a counter.
//   * R28's cap of 20 (`CALL_TO_CHAOS_CHAIN_CAP`) is a HARD stop: a roll that lands on the
//     recursion once the chain is at the cap resolves into nothing and no substitute effect is
//     rolled (R87), so a radiant Call at the cap runs only its partner.
// Rebuilding any of that here would be a second source of truth for the same rules.
//
// `callToChaos()` reads `ctx.radiant` when no argument is given, which would work too — the flag
// `makeContext` puts in the context is the same flag `scriptOf` used to pick this face. The flag is
// passed explicitly anyway so each face states which text of §8 it is, and so neither depends on
// the context plumbing to tell the two apart.
//
// Two rulings worth naming here because they are invisible in the one-liner: R70 makes the
// recursion a Cast — free, counted as a play, running the card's own script, with the caster
// picking targets — and R87 sends a card cast from no zone to the caster's graveyard when it
// resolves (§10.5 step 7), which is what feeds Gravedigger and Reminisce down a long chain.

import type { Script } from "@jackioh/engine";
import { subsystems } from "@jackioh/engine";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-095");

/** §8: "One random effect" out of the ten. */
export const base: Script = { cry: () => [subsystems.callToChaos({ radiant: false })] };

/** §8, R28: "cast a random Call to Chaos" plus one of the other 9, the recursion first (R87). */
export const radiant: Script = { cry: () => [subsystems.callToChaos({ radiant: true })] };
