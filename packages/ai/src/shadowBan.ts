// R186: the AI's shadow ban. The cards the AI never deals into its own decks, each with the reason
// the sweep flagged. It governs AI deck-building (`buildAiDeck`'s default `banned`) and nothing else:
// a banned card stays legal for every player, a human may play it against the AI, and the AI still
// has to answer it. It is not §9.4 L6's ban, which is server state (R164).
//
// How an entry gets here: `pnpm ai:sweep` (scripts/sweep.ts) forces each non-token Core card into
// AI decks at every tier in AI_SWEEP.tiers (Easy and Hard) against the greedy baseline and prints
// one row per flagged card and tier, together with a ready-made entry. A flag at either tier bans
// the card at every tier, and the reason names the tier after the flags ("neverPlayed: hard: …").
// No card is listed without a flag, and the ban is not tuned by hand.
//
// Sweep of record: 2026-09-23 (UTC), `pnpm ai:sweep` over the 100 non-token Core cards at easy and
// hard, starting from the table before it (Field of Dreams, /fullsend and Ceaseless Void, swept as
// forced-in cards like any other), AI_SWEEP.seedsPerCard (8) seeds per card and tier
// (`sweep:<tier>:<id>:1..8`), budget AI_GATE_BUDGET, which is AI_BUDGET {"nodes":600,
// "lethalNodes":150,"determinizations":3,"beamWidth":4,"rootBranching":20,"branching":6,
// "maxDepth":8,"finalists":3}, run as six parallel slices (`--json`, joined with `--report`). It
// flagged the twelve `neverPlayed` cards below: three at Easy, eight at Hard only, and Eugenics at
// both. No card was flagged `error`, `timeout` or `selfHarm`. Field of Dreams and Ceaseless Void
// were played this time at both tiers, so they are no longer banned; /fullsend was played at Easy
// and never at Hard. Hinder is the one card no tier could judge: it is cast on draw, so it never
// sits in hand (unswept, not banned).

/** R186: defId → why the AI never deals it to itself. Each reason starts "<SweepFlag>: <tier>: ". */
export const SHADOW_BAN: Readonly<Record<string, string>> = {
  "core-007": "neverPlayed: hard: affordable in hand on 6 turns, never played",
  "core-026": "neverPlayed: hard: affordable in hand on 17 turns, never played",
  "core-027": "neverPlayed: hard: affordable in hand on 4 turns, never played",
  "core-033": "neverPlayed: hard: affordable in hand on 11 turns, never played",
  "core-042":
    "neverPlayed: easy: affordable in hand on 34 turns, never played; hard: affordable in hand on 23 turns, never played",
  "core-059": "neverPlayed: hard: affordable in hand on 17 turns, never played",
  "core-078": "neverPlayed: hard: affordable in hand on 16 turns, never played",
  "core-079": "neverPlayed: hard: affordable in hand on 6 turns, never played",
  "core-082": "neverPlayed: hard: affordable in hand on 15 turns, never played",
  "core-083": "neverPlayed: easy: affordable in hand on 18 turns, never played",
  "core-090": "neverPlayed: hard: affordable in hand on 20 turns, never played",
  "core-099": "neverPlayed: easy: affordable in hand on 14 turns, never played",
};

/** Object.keys(SHADOW_BAN), sorted. */
export const SHADOW_BAN_IDS: readonly string[] = Object.keys(SHADOW_BAN).sort();
