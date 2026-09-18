// SPEC §8.1 #4 Gary the Gambler — 1/1 → 2/2 Unit, Human, cost 1.
// Base: "Cry: flip 5 coins; +1 attack per heads, +1 max health per tails".
// Radiant: "7 coins; +2 per heads, +2 per tails" — the cell changes only the numbers of the base
// clause (§8 Conventions), so it is the same flip at 7 coins and 2 per side.
//
// Engine cell: 5 or 7 seeded rolls and a permanent buff layer (§10.4 layer 4). R32: Lucky has no
// defined "best" for a coin-stat effect, so it does not apply — the flip never consults it, which
// is why this file asks for plain coins and no `lucky` option.

import type { Script } from "@jackioh/engine";
// BLOCKED: `flipCoins` does not exist in packages/engine/src/effects (the barrel at
// packages/engine/src/effects/index.ts is the whole card-script vocabulary, and no verb there rolls
// dice inside an effect). A card file may not call `ctx.rng` itself — that is state and randomness
// in a card script (CLAUDE.md rules 4 and 5) — so the rolls have to live in an effect. Proposed
// addition to effects/buff.ts, re-exported from that barrel:
//   flipCoins({ target: TargetSpec; coins: number; perHeads?: BuffAmount; perTails?: BuffAmount })
// making exactly `coins` seeded `ctx.rng.coin()` calls and applying the totals as ONE layer-4 buff
// (one `buffed` event), so heads + tails always accounts for every flip and a replay at the same
// seed and cursor reproduces it (§10.7, R32: no Lucky reroll).
import { flipCoins } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-004");

export const base: Script = {
  cry: () => [
    flipCoins({ target: { of: "self" }, coins: 5, perHeads: { attack: 1 }, perTails: { health: 1 } }),
  ],
};

export const radiant: Script = {
  cry: () => [
    flipCoins({ target: { of: "self" }, coins: 7, perHeads: { attack: 2 }, perTails: { health: 2 } }),
  ],
};
