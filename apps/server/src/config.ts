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
// `apps/web` imports this file by relative path, so it ships to browsers: only public values may
// ever live here, never a secret (secrets are environment variables, read by `src/env.ts`).
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
// How a typed code is read (R191), and the client's sign-in numbers (R192, R194).
// ---------------------------------------------------------------------------------------------

// PUBLIC VALUES ONLY. `apps/web` imports this file by relative path (the code field, the sign-in
// screens), so everything in it ships to browsers. It holds no secret and must never hold one: a
// secret added here later would be in every client bundle. Secrets live in the environment
// (`src/env.ts`), which the web never imports.

/**
 * SPEC §11 R191: raw code input longer than this is malformed without being read, so config bounds
 * the work a redemption does, not the caller. Four times a formatted invite code, which leaves room
 * for any spacing a person or a mail client adds.
 */
export const CODE_INPUT_MAX_LENGTH = 64;

/**
 * R191: the shape `@jackioh/shared`'s `readCodeInput` reads an invite code with. A plain literal
 * (structurally a `CodeFormat`), because this file imports nothing.
 */
export const INVITE_CODE_FORMAT = {
  alphabet: CODE_ALPHABET,
  length: INVITE_CODE_LENGTH,
  groupSize: INVITE_CODE_GROUP_SIZE,
  separator: INVITE_CODE_SEPARATOR,
  maxInputLength: CODE_INPUT_MAX_LENGTH,
} as const;

/** R191, R79: a room code is one group of `ROOM_CODE_LENGTH` from the same alphabet. */
export const ROOM_CODE_FORMAT = {
  alphabet: CODE_ALPHABET,
  length: ROOM_CODE_LENGTH,
  groupSize: ROOM_CODE_LENGTH,
  separator: INVITE_CODE_SEPARATOR,
  maxInputLength: CODE_INPUT_MAX_LENGTH,
} as const;

/**
 * SPEC §11 R190: how many `X-Forwarded-For` entries, counted from the right, the deployment's own
 * proxies wrote, when `TRUSTED_PROXY_HOPS` does not say. Zero: with no proxy in front (a local or
 * E2E server) the header is whatever the caller wrote, and trusting it would let a caller choose its
 * own per-IP bucket. A deployment behind a proxy says so explicitly (`render.yaml` sets 1).
 */
export const DEFAULT_TRUSTED_PROXY_HOPS = 0;
/** R190: the most hops `TRUSTED_PROXY_HOPS` may name; anything above it is a misconfiguration. */
export const MAX_TRUSTED_PROXY_HOPS = 5;
/**
 * R190: an IPv6 client is counted by its first this-many bits. A /64 is only the least a line is
 * handed: many ISPs delegate a /56 to one home, and a tunnel broker routes a /48 to anyone who asks,
 * so keying on the /64 gave one host 256 (or 65,536) fresh buckets. A /56 is the usual compromise:
 * it closes the home delegation, and the price is that IPv6 neighbours sharing a /56 share a bucket.
 */
export const IPV6_RATE_LIMIT_PREFIX_BITS = 56;

/**
 * The largest request body the API reads, in bytes. Every body the API accepts is a small JSON
 * object (a code, three decks of card ids), so 64 KiB is generous; past it the body is refused
 * before it is parsed.
 */
export const API_MAX_BODY_BYTES = 65_536;

/** The client's sign-up check, mirroring Supabase Auth's default minimum password length. */
export const AUTH_PASSWORD_MIN_LENGTH = 6;
/**
 * The auth provider's bcrypt limit, in UTF-8 BYTES (the provider measures a Go string, and bcrypt
 * reads bytes), not characters: a letter outside ASCII takes two to four of them.
 */
export const AUTH_PASSWORD_MAX_LENGTH = 72;
/** SPEC §11 R192: the provider's per-address email interval, which the resend button waits out. */
export const AUTH_EMAIL_RESEND_COOLDOWN_SECONDS = 60;
/**
 * SPEC §11 R193: how long this browser remembers the address it signed up with or asked to reset,
 * for comparing an emailed link against. The provider's email links last at most a day (its email
 * OTP expiry is capped there), so an older address could only ever be matched by someone else's.
 */
export const AUTH_PENDING_ADDRESS_TTL_SECONDS = 86_400;
/** SPEC §11 R194: a session this close to expiring is renewed before it is used. */
export const AUTH_SESSION_REFRESH_MARGIN_SECONDS = 60;
/**
 * R194: an open screen's token is renewed ahead of its expiry at most once per this many seconds,
 * so a provider that issues tokens shorter-lived than the margin cannot set off a renewal loop.
 */
export const AUTH_SESSION_RENEWAL_FLOOR_SECONDS = 10;
/**
 * R194: how long sign-out waits to renew an expired session so it can revoke it, before it loads
 * the landing page anyway. A live session is revoked without waiting at all.
 */
export const AUTH_SIGN_OUT_WAIT_SECONDS = 5;
/**
 * SPEC §11 R194: how long the API remembers that an access token's session is still live at the
 * auth provider. A session the provider has ended (a sign-out, a link's session that was dropped, a
 * password reset that signed other devices out) stops being honoured here within this many seconds,
 * not when its access token expires.
 */
export const AUTH_SESSION_LIVE_CACHE_SECONDS = 30;
/** A request to the auth provider that has not answered in this long is a network failure. */
export const AUTH_PROVIDER_TIMEOUT_SECONDS = 30;
/**
 * A request to this server that has not answered in this long is a network failure. Longer than the
 * provider's, because Render's free tier takes about 50 s to wake a sleeping instance.
 */
export const API_REQUEST_TIMEOUT_SECONDS = 75;
/** How long the gate's "Checking your account…" waits before it offers a way out and says why. */
export const GATE_SLOW_NOTICE_SECONDS = 5;
/**
 * R192: the code screen reads `/api/codes/status` again when a wait it stated runs out, but never
 * sooner than this after the last read, so a wait that has just lapsed cannot make it poll.
 */
export const CODE_STATUS_RECHECK_FLOOR_SECONDS = 1;

// ---------------------------------------------------------------------------------------------
// Redemption rate limits (§9.4).
// ---------------------------------------------------------------------------------------------

// SPEC §9.4 step 2: "reject if this profile made more than 5 attempts in the last hour" — the
// limit is exceeded strictly *after* the 5th attempt, so the check must be `attempts > 5`, never
// `attempts >= 5`.
//
// Which attempt is the first refused: the SEVENTH, not the sixth as this comment used to say. The
// count is taken before the attempt is logged (`codes.ts` step 2 runs ahead of step 4), so attempt
// N sees N-1 rows. Attempt 6 sees 5, and 5 is not "more than 5", so it is allowed; attempt 7 sees
// 6 and is refused. That is the spec's sentence read literally, which is what rules here — a
// budget of "5 per hour" that admits 6 tries looks off by one until you notice the count excludes
// the attempt being made.
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
// Saved decks and trios (SPEC §9.4, R250–R256). PUBLIC: the deck builder imports these too.
// ---------------------------------------------------------------------------------------------

/** SPEC §11 R250: how many named decks a profile may save. Mirrored in `app.settings` (0007). */
export const MAX_SAVED_DECKS = 10;
/** SPEC §11 R252: how many trios a profile may save. Mirrored in `app.settings` (0007). */
export const MAX_SAVED_TRIOS = 5;
/**
 * SPEC §11 R250, R252: the longest deck or trio name, in characters once trimmed. Long enough for
 * "Midrange Humans (anti-aggro)", short enough for a tab, a list row and a sentence in a message.
 * Mirrored in `app.settings` (0007).
 */
export const DECK_NAME_MAX_LENGTH = 40;
/** SPEC §11 R255: the deck-code format's version; a code naming any other version is refused. */
export const DECK_CODE_VERSION = 1;
/**
 * SPEC §11 R255: raw deck-code input longer than this is refused before it is read. A v1 code for
 * a full deck with the longest name is under 200 characters, so this leaves room for whatever a
 * chat client wraps around a pasted code.
 */
export const DECK_CODE_MAX_INPUT_LENGTH = 512;
/** SPEC §11 R256: how long the builder waits after the last edit before it saves. */
export const DECK_AUTOSAVE_DEBOUNCE_MS = 800;
/** SPEC §11 R256: how long the builder waits before it tries a failed save again. */
export const DECK_AUTOSAVE_RETRY_SECONDS = 5;

// ---------------------------------------------------------------------------------------------
// Queue modes and the Best-of-3 series (SPEC §9.5, R257–R264).
// ---------------------------------------------------------------------------------------------

/** SPEC §11 R259: game wins that take a Best-of-3 series. */
export const SERIES_WINS_NEEDED = 2;
/**
 * SPEC §11 R259: the most games a series plays: one per deck of a trio, since a deck is played at
 * most once in a series. `test/api/series.test.ts` asserts it equals the validator's `TRIO_DECKS`.
 */
export const SERIES_MAX_GAMES = 3;
/** SPEC §11 R260: how long both players have to pick their deck for the next game of a series. */
export const SERIES_PICK_SECONDS = 60;
/** SPEC §11 R263: how often the series sweeper runs (pick clocks, and games a restart left unstarted). */
export const SERIES_SWEEP_INTERVAL_SECONDS = 5;
/**
 * SPEC §11 R263: how long a series game may sit unstarted before the sweeper starts it. Longer
 * than any request that is starting it itself, so the sweeper never races a live start.
 */
export const SERIES_START_GRACE_SECONDS = 15;
/** How often the series screen and the match screen's series banner re-read the series. */
export const SERIES_POLL_SECONDS = 2;

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
  CODE_INPUT_MAX_LENGTH,
  DEFAULT_TRUSTED_PROXY_HOPS,
  MAX_TRUSTED_PROXY_HOPS,
  IPV6_RATE_LIMIT_PREFIX_BITS,
  API_MAX_BODY_BYTES,
  AUTH_PASSWORD_MIN_LENGTH,
  AUTH_PASSWORD_MAX_LENGTH,
  AUTH_EMAIL_RESEND_COOLDOWN_SECONDS,
  AUTH_PENDING_ADDRESS_TTL_SECONDS,
  AUTH_SESSION_REFRESH_MARGIN_SECONDS,
  AUTH_SESSION_RENEWAL_FLOOR_SECONDS,
  AUTH_SIGN_OUT_WAIT_SECONDS,
  AUTH_SESSION_LIVE_CACHE_SECONDS,
  AUTH_PROVIDER_TIMEOUT_SECONDS,
  API_REQUEST_TIMEOUT_SECONDS,
  GATE_SLOW_NOTICE_SECONDS,
  CODE_STATUS_RECHECK_FLOOR_SECONDS,
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
  MAX_SAVED_DECKS,
  MAX_SAVED_TRIOS,
  DECK_NAME_MAX_LENGTH,
  DECK_CODE_VERSION,
  DECK_CODE_MAX_INPUT_LENGTH,
  DECK_AUTOSAVE_DEBOUNCE_MS,
  DECK_AUTOSAVE_RETRY_SECONDS,
  SERIES_WINS_NEEDED,
  SERIES_MAX_GAMES,
  SERIES_PICK_SECONDS,
  SERIES_SWEEP_INTERVAL_SECONDS,
  SERIES_START_GRACE_SECONDS,
  SERIES_POLL_SECONDS,
  TURN_CLOCK_MS,
  PROMPT_CLOCK_MS,
  DISCONNECT_GRACE_MS,
  MATCH_CEILING_MS,
} as const);
