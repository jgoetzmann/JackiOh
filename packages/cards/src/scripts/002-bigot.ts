// SPEC §8.1 #2 Bigot — 6/1 → 12/2 Unit, Human, cost 2.
// Base: "Cry: destroy target enemy non-Human unit". Radiant: "Cry: destroy all enemy non-Human
// units" — the radiant cell restates the clause, so it replaces the base one (§8 Conventions) and
// the radiant form declares no target at all.
//
// Engine cell: a targeted Cry with a tag filter. The pick is a play-time choice, not a prompt: it
// travels in the `play` action and never pauses resolution (R81), the engine checks it against this
// declaration and against the board (R90), and a board with no legal enemy non-Human still allows
// the play — the unit enters and the Cry fizzles (§8 Conventions, R90).

import type { Script } from "@jackioh/engine";
// BLOCKED: `destroyAll` does not exist in packages/engine/src/effects (see the barrel at
// packages/engine/src/effects/index.ts, which is the whole card-script vocabulary). The radiant
// form needs a set-wide destroy; proposed signature, to live in effects/destroy.ts and be
// re-exported from that barrel:
//   destroyAll({ side: PlayerSpec | "both"; of?: ("unit" | "backrow")[]; type?; tags?; notTags? })
// marking every match exactly as `destroy` does, so they are all collected in one state check (R59)
// and nothing dies between the marks.
import { destroy, destroyAll } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-002");

export const base: Script = {
  targets: [
    { kind: "target", min: 1, max: 1, filter: { side: "enemy", of: ["unit"], notTags: ["Human"] } },
  ],
  cry: () => [destroy({ target: { of: "chosen" } })],
};

export const radiant: Script = {
  cry: () => [destroyAll({ side: "enemy", rows: ["units"], notTags: ["Human"] })],
};
