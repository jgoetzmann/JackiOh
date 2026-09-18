// The server half of BUILD §2's constants table (`apps/server/src/config.ts`, added in M7).
// It carries R79 (match lifecycle defaults) plus every other server-side number that SPEC §9
// requires but does not itself pin down. Nothing in `apps/server` hard-codes these values.
//
// This file is dependency-free by design: `apps/server` is not yet listed in
// `pnpm-workspace.yaml`, so it cannot import `@jackioh/engine` or any other workspace package.
// Engine constants such as `DECK_SIZE`, `MAX_MANA` etc. are NOT re-declared here — they live in
// `packages/engine/src/config.ts` and are imported directly at the call site once the workspace
// wiring lands.
//
// Every `SPEC §11 Rnnn` marker below is a value SPEC §9 does not pin down and SPEC §11 now
// records as a ruling (R104-R112, added per CLAUDE.md rule 3). The comment is the
// cross-reference between this file and that table.

// ---------------------------------------------------------------------------------------------
// R79 — match lifecycle defaults (SPEC §9.5, BUILD §2). Exact names per BUILD §2's last
// paragraph; do not rename or re-derive these.
// ---------------------------------------------------------------------------------------------

/** R79: the turn clock belongs to the active player and ends a stalled turn. */
export const TURN_CLOCK_SECONDS = 75;
/** R79: a prompt held by the non-active player (e.g. a trap firing on the opponent's turn). */
export const PROMPT_CLOCK_SECONDS = 30;
/** R79: grace window after a disconnect before `disconnectExpired` ends the match as a loss. */
export const DISCONNECT_GRACE_SECONDS = 60;
/** R79: hard wall-clock ceiling; reaching it ends the match as a draw via `ceilingReached`. */
export const MATCH_CEILING_MINUTES = 60;
/** R79, §9.5: room codes are 6 characters from the invite-code alphabet. */
export const ROOM_CODE_LENGTH = 6;
/** R79, §9.5: Elo K-factor. */
export const ELO_K = 32;
/** R79, §9.5: starting Elo rating for a new profile. */
export const ELO_START = 1000;

// ---------------------------------------------------------------------------------------------
// The code alphabet (§9.4, §9.5).
// ---------------------------------------------------------------------------------------------

// SPEC §9.4: invite codes are "16 characters (80 bits) from a 32-symbol alphabet without
// 0/O/1/I/l, formatted XXXX-XXXX-XXXX-XXXX". SPEC §9.5 (R79): room codes are "6 characters from
// the invite-code alphabet". 32 symbols means log2(32) = 5 bits per character, so 16 characters
// carry exactly 80 bits and 6 characters carry exactly 30 bits.
//
// SPEC §11 R104: the alphabet string itself is not written out in SPEC §9.4; this is the only
// 32-symbol set matching its exclusions. It is built from the 36 uppercase letters+digits minus
// the 4 excluded characters (0, O, 1, I) = 32 symbols: 23456789ABCDEFGHJKLMNPQRSTUVWXYZ.
// The alphabet is uppercase-only, so SPEC's exclusion of lowercase `l` is satisfied by
// normalising any user-entered code to upper case before comparison, rather than by omitting a
// lowercase `l` that could never appear here in the first place.
export const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** §9.4: invite codes are 16 characters long (80 bits over `CODE_ALPHABET`). */
export const INVITE_CODE_LENGTH = 16;
/** §9.4: invite codes are formatted in groups of 4, e.g. XXXX-XXXX-XXXX-XXXX. */
export const INVITE_CODE_GROUP_SIZE = 4;
/** §9.4: the separator between groups in the formatted invite code. */
export const INVITE_CODE_SEPARATOR = "-";

// ---------------------------------------------------------------------------------------------
// Redemption rate limits (§9.4).
// ---------------------------------------------------------------------------------------------

// SPEC §9.4 step 2: "reject if this profile made more than 5 attempts in the last hour" — the
// limit is exceeded strictly *after* the 5th attempt, so the check must be `attempts > 5`
// (the 6th attempt is the first rejection), never `attempts >= 5`.
export const CODE_ATTEMPTS_PER_PROFILE_PER_HOUR = 5;
// SPEC §9.4 step 3: "reject if this IP hash made more than 20" — same strictness: `> 20`, not
// `>= 20`.
export const CODE_ATTEMPTS_PER_IP_PER_HOUR = 20;
/** §9.4: the rolling window both attempt limits above are counted over, in seconds. */
export const CODE_ATTEMPT_WINDOW_SECONDS = 3600;

// ---------------------------------------------------------------------------------------------
// Constant-time failure (§9.4, BUILD M6-T1).
// ---------------------------------------------------------------------------------------------

// SPEC §9.4: "Missing, expired and exhausted codes return an identical error in identical
// time." BUILD M6-T1's acceptance test wants the three failure responses within 5 ms of each
// other over 50 samples, which this floor is meant to comfortably clear: every redemption
// response (success or failure) is padded, if it finishes early, to take at least this long,
// so the wall-clock time never leaks which of the three checks failed.
//
// SPEC §11 R107: the floor duration itself is not fixed by SPEC §9.4. 250 ms is comfortably above a
// slow round trip to Postgres (steps 1-5 of the §9.4 transaction plus a couple of hash
// comparisons), while still being an unnoticeable delay for a human clicking "redeem".
export const REDEMPTION_RESPONSE_FLOOR_MS = 250;

// SPEC §9.4: the single client-facing message for missing, expired and exhausted codes — never
// distinguish between the three in user-visible text or in timing.
export const REDEMPTION_IDENTICAL_ERROR = "This invite code is invalid.";

// ---------------------------------------------------------------------------------------------
// The circuit breaker (§9.4).
// ---------------------------------------------------------------------------------------------

// SPEC §9.4: "A global circuit breaker disables redemption and alerts when system-wide failures
// cross a threshold in a window" — SPEC fixes neither the threshold nor the window.
//
// SPEC §11 R106: 100 failed redemption attempts (across all profiles and IPs) within 600 s trips
// the breaker. High enough that normal typo/expired-code traffic never trips it, low enough to
// catch a scripted brute-force attempt quickly.
export const REDEMPTION_CIRCUIT_FAILURE_THRESHOLD = 100;
/** SPEC §11 R106: the rolling window the circuit breaker counts failures over, in seconds. */
export const REDEMPTION_CIRCUIT_WINDOW_SECONDS = 600;

// ---------------------------------------------------------------------------------------------
// Matchmaking (§9.5, BUILD M7-T3).
// ---------------------------------------------------------------------------------------------

/** §9.5: the rating window's starting half-width, in Elo points, at the moment a ticket enqueues. */
export const RATING_WINDOW_START = 100;
/** §9.5: the rating window widens by this many Elo points every `RATING_WINDOW_WIDEN_EVERY_SECONDS`. */
export const RATING_WINDOW_WIDEN_BY = 50;
/** §9.5: the cadence, in seconds, at which the rating window widens. */
export const RATING_WINDOW_WIDEN_EVERY_SECONDS = 10;
/** §9.5: past this many seconds waited, the rating window is uncapped (any opponent qualifies). */
export const RATING_WINDOW_UNCAPPED_AFTER_SECONDS = 60;

// SPEC §9.5: "Pairing runs on enqueue plus a sweeper every few seconds" — the exact cadence is
// not fixed by SPEC.
//
// SPEC §11 R108: 3 s. Frequent enough that a ticket is rarely left waiting past its next window
// widen before being reconsidered, without hammering the ticket table.
export const MATCHMAKER_SWEEP_INTERVAL_SECONDS = 3;

/**
 * §9.5: the half-width of the acceptable rating gap for a ticket that has waited
 * `waitedSeconds`. Shared by the pairing query and its tests so both read one implementation.
 *
 * At `waitedSeconds = 0` this is `RATING_WINDOW_START`; it widens by `RATING_WINDOW_WIDEN_BY`
 * every `RATING_WINDOW_WIDEN_EVERY_SECONDS`, and returns `Number.POSITIVE_INFINITY` once
 * `waitedSeconds` passes `RATING_WINDOW_UNCAPPED_AFTER_SECONDS` (any opponent qualifies).
 */
export function ratingWindow(waitedSeconds: number): number {
  if (waitedSeconds >= RATING_WINDOW_UNCAPPED_AFTER_SECONDS) {
    return Number.POSITIVE_INFINITY;
  }
  const clampedWait = Math.max(waitedSeconds, 0);
  const widenSteps = Math.floor(clampedWait / RATING_WINDOW_WIDEN_EVERY_SECONDS);
  return RATING_WINDOW_START + widenSteps * RATING_WINDOW_WIDEN_BY;
}

// ---------------------------------------------------------------------------------------------
// Elo (R79, BUILD M7-T2).
// ---------------------------------------------------------------------------------------------

/**
 * R79: the standard Elo rating update, using `ELO_K`. `scoreA` is player A's result against
 * player B: 1 for a win, 0 for a loss, 0.5 for a draw (`ceilingReached`).
 *
 * Both outputs are rounded to the nearest integer (`Math.round`, ties away from zero) since
 * `profiles.rating` is an integer column; the two players' deltas are computed independently
 * from the same pre-match ratings, so they need not sum to zero after rounding.
 */
export function eloUpdate(
  ratingA: number,
  ratingB: number,
  scoreA: 0 | 0.5 | 1,
): { a: number; b: number } {
  const expectedA = 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
  const expectedB = 1 - expectedA;
  const scoreB = 1 - scoreA;
  return {
    a: Math.round(ratingA + ELO_K * (scoreA - expectedA)),
    b: Math.round(ratingB + ELO_K * (scoreB - expectedB)),
  };
}

// ---------------------------------------------------------------------------------------------
// Action flooding (§9.8).
// ---------------------------------------------------------------------------------------------

// SPEC §9.8: "Per-match rate limit in the actor, per-account rate limit at the API" — neither
// number is fixed by SPEC.
//
// SPEC §11 R109: 5 actions/second sustained per match comfortably covers legitimate play (even a
// fast combo turn resolves as a handful of actions) while blocking a scripted flood.
export const MATCH_ACTIONS_PER_SECOND = 5;
// SPEC §11 R109: 300 requests/minute per account across the API is generous for normal client
// polling and UI use while still bounding a runaway or malicious client.
export const API_REQUESTS_PER_MINUTE = 300;

// ---------------------------------------------------------------------------------------------
// The reaper (§9.5).
// ---------------------------------------------------------------------------------------------

// SPEC §9.5: "a reaper resolves anything past the ceiling" — the polling cadence is not fixed
// by SPEC.
//
// SPEC §11 R108: 30 s. The ceiling itself is a 60-minute wall clock, so a half-minute reaper
// sweep resolves a stuck match promptly without meaningfully scanning `matches` too often.
export const MATCH_REAPER_INTERVAL_SECONDS = 30;

// ---------------------------------------------------------------------------------------------
// Derived millisecond helpers, since timers (setTimeout/alarms) take milliseconds.
// ---------------------------------------------------------------------------------------------

/** R79: `TURN_CLOCK_SECONDS` in milliseconds. */
export const TURN_CLOCK_MS = TURN_CLOCK_SECONDS * 1000;
/** R79: `PROMPT_CLOCK_SECONDS` in milliseconds. */
export const PROMPT_CLOCK_MS = PROMPT_CLOCK_SECONDS * 1000;
/** R79: `DISCONNECT_GRACE_SECONDS` in milliseconds. */
export const DISCONNECT_GRACE_MS = DISCONNECT_GRACE_SECONDS * 1000;
/** R79: `MATCH_CEILING_MINUTES` in milliseconds. */
export const MATCH_CEILING_MS = MATCH_CEILING_MINUTES * 60 * 1000;

// ---------------------------------------------------------------------------------------------
// Frozen snapshot for logging at boot. Does not replace the named exports above; every call
// site should keep importing the specific constant it needs.
// ---------------------------------------------------------------------------------------------

export const SERVER_CONFIG = Object.freeze({
  TURN_CLOCK_SECONDS,
  PROMPT_CLOCK_SECONDS,
  DISCONNECT_GRACE_SECONDS,
  MATCH_CEILING_MINUTES,
  ROOM_CODE_LENGTH,
  ELO_K,
  ELO_START,
  CODE_ALPHABET,
  INVITE_CODE_LENGTH,
  INVITE_CODE_GROUP_SIZE,
  INVITE_CODE_SEPARATOR,
  CODE_ATTEMPTS_PER_PROFILE_PER_HOUR,
  CODE_ATTEMPTS_PER_IP_PER_HOUR,
  CODE_ATTEMPT_WINDOW_SECONDS,
  REDEMPTION_RESPONSE_FLOOR_MS,
  REDEMPTION_IDENTICAL_ERROR,
  REDEMPTION_CIRCUIT_FAILURE_THRESHOLD,
  REDEMPTION_CIRCUIT_WINDOW_SECONDS,
  RATING_WINDOW_START,
  RATING_WINDOW_WIDEN_BY,
  RATING_WINDOW_WIDEN_EVERY_SECONDS,
  RATING_WINDOW_UNCAPPED_AFTER_SECONDS,
  MATCHMAKER_SWEEP_INTERVAL_SECONDS,
  MATCH_ACTIONS_PER_SECOND,
  API_REQUESTS_PER_MINUTE,
  MATCH_REAPER_INTERVAL_SECONDS,
  TURN_CLOCK_MS,
  PROMPT_CLOCK_MS,
  DISCONNECT_GRACE_MS,
  MATCH_CEILING_MS,
} as const);
