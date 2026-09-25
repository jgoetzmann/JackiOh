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
// Sweep of record: 2026-09-25 (UTC), `pnpm ai:sweep` over 100 non-token Core cards at easy and hard,
// 8 seeds per card and tier (`sweep:<tier>:<id>:<n>`), budget AI_GATE_BUDGET {"nodes":600,
// "lethalNodes":150,"determinizations":3,"beamWidth":4,"rootBranching":20,"branching":6,
// "maxDepth":8,"finalists":3}, re-run after the Radiant pass (R275, R276) changed 27 Radiant faces.
// It ran as five parallel slices on a busy machine, which flagged 30 cards `timeout`; each was swept
// again (three slices on a quiet machine, then Friend of Felinors and Conjure KY alone, twice for
// Conjure KY), and only Conjure KY's hard-tier timeout held, so it is the one `timeout` entry. The
// rest are `neverPlayed`, as before. Against the table before it: Right-house defender, Field of
// Dreams and Genn's Greed are new (hard), and Conjure KY; Jewelosco Scarab, Unstable Clone Machine,
// KY's Trial and CN-Viral Injection were played this time and come off; and Blood Ridden Glowy
// Jelly Bean, which is cast on draw, was never affordable at either tier, so like Hinder it is
// unswept and not listed (R186: no evidence either way). No card was flagged `error` or `selfHarm`.

/** R186: defId → why the AI never deals it to itself. Each reason starts "<SweepFlag>: <tier>: ". */
export const SHADOW_BAN: Readonly<Record<string, string>> = {
  "core-003": "neverPlayed: hard: affordable in hand on 6 turns, never played",
  "core-026": "neverPlayed: easy: affordable in hand on 21 turns, never played",
  "core-042": "neverPlayed: hard: affordable in hand on 19 turns, never played",
  "core-057": "timeout: hard: 1 decision(s) over 2000 ms or game(s) past 600 actions",
  "core-059": "neverPlayed: hard: affordable in hand on 22 turns, never played",
  "core-076": "neverPlayed: hard: affordable in hand on 16 turns, never played",
  "core-078": "neverPlayed: easy: affordable in hand on 9 turns, never played",
  "core-079": "neverPlayed: hard: affordable in hand on 6 turns, never played",
  "core-083": "neverPlayed: hard: affordable in hand on 21 turns, never played",
  "core-094": "neverPlayed: hard: affordable in hand on 16 turns, never played",
  "core-099":
    "neverPlayed: easy: affordable in hand on 17 turns, never played; hard: affordable in hand on 31 turns, never played",
};

/** Object.keys(SHADOW_BAN), sorted. */
export const SHADOW_BAN_IDS: readonly string[] = Object.keys(SHADOW_BAN).sort();
