/**
 * Invite codes and SPEC §9.4's six-step redemption transaction.
 *
 * §9.4, quoted, is the whole specification of this file:
 *
 *   "Codes: 16 characters (80 bits) from a 32-symbol alphabet without 0/O/1/I/l, formatted
 *    XXXX-XXXX-XXXX-XXXX, stored hashed. Redemption is one server-side transaction: (1) reject
 *    unless the account is pending with a verified email; (2) reject if this profile made more
 *    than 5 attempts in the last hour; (3) reject if this IP hash made more than 20; (4) log the
 *    attempt either way; (5) look up by hash and reject if revoked, expired or exhausted; (6)
 *    increment uses and set the account active, atomically. Missing, expired and exhausted codes
 *    return an identical error in identical time. A global circuit breaker disables redemption
 *    and alerts when system-wide failures cross a threshold in a window."
 *
 * §9.8's "Invite code brute force" row names the same mitigations: "80-bit hashed codes,
 * per-account and per-IP limits, verified email, circuit breaker (9.4)".
 *
 * WHERE THE TRANSACTION LIVES. All six steps are `deps.store.redeem` — one port call, which the
 * Postgres store answers with one statement (`select app.redeem_invite_code(...)`, migration 0001
 * §6) and the in-memory stores answer with the same six steps in SPEC's order. This file used to
 * orchestrate them out of six separate port calls inside `Store.tx`, which committed as one real
 * transaction but meant §9.4 was implemented twice — once here in TypeScript and once in the SQL
 * function that sat unused. The two consequences of §9.4's ordering that used to be stated here
 * are now stated where they are enforced (`ports.ts`, `Store.redeem`): steps 2 and 3 reject before
 * step 4 so the window drains, and a rejection is returned rather than thrown so the attempt row
 * survives.
 *
 * WHAT IS STILL THIS FILE'S. Three things the store cannot do and §9.4 still requires:
 *  - R107's response floor. "Identical time" is padding, and SQL cannot pad.
 *  - R106's circuit breaker: the one that alerts, backs `GET /api/codes/status` and disables
 *    redemption before the store is touched. `Store.redeem` may also answer `circuit_open` from
 *    the database's own switch; both come back as the same 503.
 *  - R145's distinctions. The store answers `not_pending` for "no such profile", "banned" and
 *    "already active" together; R145 requires those three to be reported distinctly, because they
 *    depend on the caller's own account and leak nothing about the code space. They are decided
 *    here, from the profile `resolveCaller` already resolved, before the store is called.
 *
 * Every constant here comes from `../config`. Nothing in this file restates a value from SPEC.
 */

import { INVITE_CODE_LENGTH, REDEMPTION_IDENTICAL_ERROR } from "../config";
import { canonicalInviteCode, formatCode, isWellFormedCode, normalizeCode } from "./crypto";
import {
  ApiError,
  badRequest,
  errorResponse,
  ok,
  padTo,
  rateLimited,
  route,
  type ApiRequest,
  type Route,
} from "./http";
import type { ApiLimits, InviteCode, Profile, RedeemResult, ServerDeps } from "./ports";

// ---------------------------------------------------------------------------
// Wording and defaults SPEC does not pin down
// ---------------------------------------------------------------------------

// NOT IN SPEC, and no R-row yet — PROPOSED RULING for §11:
//   Topic: How many accounts one invite code activates
//   Ruling: An invite code is single-use unless its mint says otherwise. §9.4 gives a code a
//     `uses` counter and a state of "exhausted" but fixes no default, and one use is the value
//     that makes the counter worth having: a code that activates one account is a unit of invite
//     an operator can hand out and account for, while a multi-use default would silently turn one
//     leaked code into an open door, which is the failure §9.8's brute-force row is about at the
//     other end. A larger `max_uses` stays available to whoever mints deliberately.
//   Affects: §9.4, §9.8, R106, R107; `api/codes.ts`, migration `0001_profiles_and_invites.sql`.
//
// One use also matches the db agent's `invite_codes.max_uses int not null default 1` in migration
// 0001, so minting through the API and inserting by hand agree.
export const DEFAULT_INVITE_CODE_MAX_USES = 1;

// SPEC §11 R145 decides which of these are allowed to be distinct at all: the identical error
// covers "every outcome that depends on the **code**", while outcomes that depend only on the
// caller's own account — "already active, banned or an unverified email" — are "reported
// distinctly, because they leak nothing about the code space". The rate-limit and breaker
// refusals are the same kind: both are facts about this caller, not about any code.
//
// Not in SPEC, and no R-row: the strings themselves. Which outcomes are distinguishable is R145's
// ruling; what each distinguishable one says is wording with no protocol consequence, since a
// client branches on the `ApiError` code and never on the sentence. Only
// `REDEMPTION_IDENTICAL_ERROR` (from ../config) is spec-mandated, and only for the code failures.
const RATE_LIMITED_MESSAGE = "Too many invite code attempts. Try again later.";
const BREAKER_MESSAGE = "Invite redemption is temporarily unavailable. Try again later.";
const ALREADY_ACTIVE_MESSAGE = "This account is already active.";
// Mirrors `assertActive`'s wording in http.ts so a banned account reads the same sentence
// wherever it is turned away.
const BANNED_MESSAGE = "this account is banned";
const EMAIL_UNVERIFIED_MESSAGE = "Verify your email address before redeeming an invite code.";

/**
 * §9.4: "Missing, expired and exhausted codes return an identical error in identical time."
 *
 * One constructor, no `details`, so all of them serialise to the same bytes as well as the same
 * status. A revoked code and a malformed one take this path too: distinguishing either would be
 * exactly the oracle §9.8's brute-force row is about. The operator-facing reason string stays in
 * `code_attempts.reason`, which §9.4 says is "never returned to the client".
 */
function identicalCodeError(): ApiError {
  return new ApiError("invalid_code", REDEMPTION_IDENTICAL_ERROR);
}

// ---------------------------------------------------------------------------
// Minting
// ---------------------------------------------------------------------------

/**
 * The four ports minting actually touches, rather than the whole `ServerDeps`. A `ServerDeps` is
 * assignable to this, so every handler keeps passing its own `deps` unchanged; the narrower type
 * is what lets `src/db/mint-code.ts` open a store and a pepper and nothing else — no auth
 * provider, no catalog, no match registry — to run the bring-up checklist's step 7.
 */
export type MintDeps = Pick<ServerDeps, "store" | "ids" | "hashes" | "timers">;

/**
 * Mints one code: `INVITE_CODE_LENGTH` characters (§9.4's 80 bits over the 32-symbol alphabet),
 * formatted `XXXX-XXXX-XXXX-XXXX` for display, stored **hashed** and never in plaintext. The
 * plaintext is returned exactly once, to whoever asked for it; nothing persists it.
 */
export async function mintInviteCode(
  deps: MintDeps,
  input: { maxUses?: number; expiresAt?: number | null } = {},
): Promise<{ id: string; formatted: string }> {
  const maxUses = input.maxUses ?? DEFAULT_INVITE_CODE_MAX_USES;
  if (!Number.isInteger(maxUses) || maxUses < 1) {
    throw new Error(`maxUses must be a positive integer (got ${String(maxUses)})`);
  }

  const plain = deps.ids.code(INVITE_CODE_LENGTH);
  // A code outside `CODE_ALPHABET` could never be redeemed (redemption rejects it as malformed),
  // so fail loudly here rather than handing ops a dead code.
  if (!isWellFormedCode(normalizeCode(plain), INVITE_CODE_LENGTH)) {
    throw new Error(
      `ids.code() produced a code outside CODE_ALPHABET; ${String(INVITE_CODE_LENGTH)} symbols from §9.4's alphabet are required`,
    );
  }

  const code: InviteCode = {
    id: deps.ids.uuid(),
    codeHash: deps.hashes.code(plain),
    maxUses,
    uses: 0,
    revoked: false,
    expiresAt: input.expiresAt ?? null,
    createdAt: deps.timers.now(),
  };
  await deps.store.codes.insert(code);
  return { id: code.id, formatted: formatCode(plain) };
}

// ---------------------------------------------------------------------------
// The circuit breaker (§9.4)
// ---------------------------------------------------------------------------

/**
 * §9.4: "A global circuit breaker disables redemption and alerts when system-wide failures cross
 * a threshold in a window."
 *
 * Deliberately a value, not module state: `createCodesRoutes()` keeps one in its closure, so
 * constructing a fresh router (which every test does) gets a fresh breaker and one caller's flood
 * cannot leak across processes' worth of tests.
 */
export type BreakerState = {
  /** Epoch ms until which redemption is disabled; 0 while closed. */
  openUntil: number;
  /** How many times this breaker has opened. One `log.alert` per opening. */
  openings: number;
};

export function createBreakerState(): BreakerState {
  return { openUntil: 0, openings: 0 };
}

// ---------------------------------------------------------------------------
// Redemption
// ---------------------------------------------------------------------------

export type RedeemOutcome = { ok: true } | { ok: false; error: ApiError };

export type RedeemInput = {
  /**
   * The caller's profile as `resolveCaller` (http.ts) resolved it for this request. Read here only
   * for R145's three distinct account refusals; the authority on "is this account still pending"
   * is `Store.redeem`, which re-reads it under a row lock inside the transaction.
   */
  profile: Profile;
  /** Whatever the client typed; normalized and hashed here, never stored. */
  plainCode: string;
  ipHash: string;
  /**
   * §9.4 step 1's "verified email", from `req.user.emailVerified` — which `auth.ts` takes from
   * the auth server's `email_confirmed_at`, never from a user-editable claim.
   *
   * Not in SPEC, and no R-row: a signature, not a rule. It is not in the signature the brief
   * sketched, but §9.4 step 1 cannot be implemented without it — `Profile` (ports.ts) carries no
   * verification flag, and the authority for one is the auth provider, not the store. What step 1
   * *does* with the flag is §9.4's, and how long a positive answer may be remembered is the
   * proposed ruling in `api/auth.ts`.
   */
  emailVerified: boolean;
  /** Omitted by a direct caller, in which case this redemption gets a breaker of its own. */
  breaker?: BreakerState;
};

export async function redeemCode(deps: ServerDeps, input: RedeemInput): Promise<RedeemOutcome> {
  const breaker = input.breaker ?? createBreakerState();
  const now = deps.timers.now();

  // R106's breaker, checked before step 1: while it is open nothing touches the profile, the
  // attempt log or the code table, which is the point of having it.
  if (now < breaker.openUntil) {
    return { ok: false, error: new ApiError("unavailable", BREAKER_MESSAGE) };
  }

  // R145's three account-shaped refusals, which `Store.redeem` answers as one `not_pending` and
  // §9.4 requires to be distinguishable. They are decided from the profile `resolveCaller` already
  // resolved for this request; the store re-checks the same thing under its own lock, so a profile
  // that changes between here and there is still caught — as `not_pending`, below.
  const profile = input.profile;
  if (profile.status === "banned") {
    return { ok: false, error: new ApiError("account_banned", BANNED_MESSAGE) };
  }
  if (profile.status === "active") {
    // Not a code failure — §9.4 only makes redemption the pending → active transition, so an
    // active account asking again is a conflict, and it is told so plainly.
    return { ok: false, error: new ApiError("conflict", ALREADY_ACTIVE_MESSAGE) };
  }
  // §9.4 step 1's "verified email", from the access token (R159). The store asks the managed-auth
  // table the same question and may still answer `email_unverified`; refusing here first is what
  // keeps an unverified caller from spending a row in the attempt log.
  if (!input.emailVerified) {
    return { ok: false, error: new ApiError("email_unverified", EMAIL_UNVERIFIED_MESSAGE) };
  }

  // §9.4: codes are "stored hashed", so the plaintext is read and hashed here and the store is
  // handed a hash. SPEC §11 R191 fixes the reading, shared with the client's code field: NFKC,
  // upper case, separators removed, and then exactly the code's length in R104's alphabet, with no
  // character dropped or mapped. Input longer than `CODE_INPUT_MAX_LENGTH` is not read at all. A
  // code that could never exist travels as `null` rather than being refused early, because §9.4
  // logs the attempt (step 4) before it looks anything up (step 5): a malformed code must cost the
  // same row a wrong one does, or it would be the one cheap probe in this endpoint.
  const canonical = canonicalInviteCode(input.plainCode);
  const codeHash = canonical === null ? null : deps.hashes.code(canonical);

  // §9.4: "Redemption is one server-side transaction." This is it.
  const result = await deps.store.redeem({ profileId: profile.id, codeHash, ipHash: input.ipHash });
  const outcome = outcomeFor(result, deps.limits);

  if (result === "circuit_open") {
    // The database's own switch (`app.settings.redemption_enabled`) is off, which this process
    // cannot read ahead of a redemption. Mirrored in the process's breaker for its cooldown, so
    // `GET /api/codes/status` says "paused" (R192) and the next presses are refused here, before
    // the store is touched: every redemption the store sees logs an attempt, and the code screen
    // would otherwise keep Redeem on and spend one of the account's tries on each press. No alert:
    // an operator flipped the switch, and the breaker's alert is for failures crossing a threshold.
    breaker.openUntil = Math.max(breaker.openUntil, now + deps.limits.breakerCooldownMs);
  }

  if (!outcome.ok) await noteFailure(deps, breaker, now);
  return outcome;
}

/**
 * `Store.redeem`'s result as the response §9.4 owes. Every code-dependent result collapses onto
 * R145's one identical error; everything else depends only on the caller's own account or on the
 * service's availability, and says so.
 */
function outcomeFor(result: RedeemResult, limits: ApiLimits): RedeemOutcome {
  switch (result) {
    case "ok":
      return { ok: true };
    case "not_pending":
      // The store re-read the profile under its lock and found it no longer pending, though this
      // request resolved it as pending moments earlier: a concurrent redemption, a ban, or the row
      // itself gone. The store cannot say which — `app.redeem_invite_code` answers `not_pending`
      // for all three from one `select … for update` — so one answer covers them, and R170 fixes
      // it as the conflict: the token verified and the caller was resolved, so nothing about their
      // authorization failed; what changed is the state the request was about. The pending →
      // active flip is also the only transition §9.4 gives redemption, so it is what almost always
      // happened.
      return { ok: false, error: new ApiError("conflict", ALREADY_ACTIVE_MESSAGE) };
    case "email_unverified":
      return { ok: false, error: new ApiError("email_unverified", EMAIL_UNVERIFIED_MESSAGE) };
    case "rate_limited_profile":
    case "rate_limited_ip":
      // §9.4 steps 2 and 3. Which of the two windows refused is not told apart: the per-IP one
      // would say something about the other accounts behind the same address.
      //
      // SPEC §11 R192: reported as a rate limit with its wait, never folded into R145's identical
      // error. The wait is the whole attempt window, an upper bound: the exact time would depend on
      // the IP window, and so on other accounts' attempts.
      return { ok: false, error: rateLimited(RATE_LIMITED_MESSAGE, limits.redeemWindowMs) };
    case "circuit_open":
      return { ok: false, error: new ApiError("unavailable", BREAKER_MESSAGE) };
    case "invalid_code":
      return { ok: false, error: identicalCodeError() };
  }
}

/**
 * §9.4: the breaker "disables redemption and alerts when system-wide failures cross a threshold
 * in a window". Counted after the transaction commits, so the failure just logged is included,
 * and outside it, because this is monitoring rather than part of the atomic redemption.
 */
async function noteFailure(
  deps: ServerDeps,
  breaker: BreakerState,
  now: number,
): Promise<void> {
  const failures = await deps.store.codes.countFailures(now - deps.limits.breakerWindowMs);
  if (failures < deps.limits.breakerFailureThreshold) return;
  // Already open: never alert twice for one opening.
  if (now < breaker.openUntil) return;

  breaker.openUntil = now + deps.limits.breakerCooldownMs;
  breaker.openings += 1;
  deps.log.alert("codes.breaker_open", {
    failures,
    threshold: deps.limits.breakerFailureThreshold,
    windowMs: deps.limits.breakerWindowMs,
    openUntil: breaker.openUntil,
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * The code as sent. Any string is read, the empty one included: `""` holds no code exactly as
 * `"----"` or `" "` does, so R191's reading calls it malformed and it gets R145's identical error
 * and its attempt row like them, after the account's own checks, rather than a request-shape
 * refusal of its own (which `str` gives an empty string). Only a code that is not a string at all
 * is a malformed request.
 */
function plainCodeOf(body: Readonly<Record<string, unknown>>): string {
  const value = body["code"];
  if (typeof value !== "string") throw badRequest('"code" must be a string');
  return value;
}

/** Never throws an `ApiError`: every rejection comes back as a value, so it can be padded. */
async function redeemForRequest(
  deps: ServerDeps,
  req: ApiRequest,
  breaker: BreakerState,
): Promise<RedeemOutcome> {
  try {
    const { profile, user } = req;
    // `auth: "user"` guarantees both; the guard is here because `ApiRequest` types them nullable.
    if (profile === null || user === null) {
      return { ok: false, error: new ApiError("unauthorized", "sign in first") };
    }
    return await redeemCode(deps, {
      profile,
      plainCode: plainCodeOf(req.body),
      ipHash: req.ipHash,
      emailVerified: user.emailVerified,
      breaker,
    });
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, error };
    // A store fault is not a code oracle (it does not depend on which code was sent), so it is
    // left to the router: 500, logged, unpadded.
    throw error;
  }
}

export function createCodesRoutes(): Route[] {
  // §9.4's breaker lives here, in this closure, rather than in module state: fresh routes mean a
  // fresh breaker, which is what lets each test drive it from a known state.
  const breaker = createBreakerState();

  return [
    // `auth: "user"`, not `"active"`: a pending account is exactly the caller this endpoint is
    // for (§9.4: "Redeeming an invite code flips pending to active").
    route("POST", "/api/codes/redeem", "user", async (req, deps) => {
      // Measured from the handler's first line: §9.4's "identical time" is about the response the
      // client sees, not about the lookup alone.
      const startedAt = deps.timers.now();
      const outcome = await redeemForRequest(deps, req, breaker);
      // Every branch is padded to the same floor — the successes too, and the breaker's 503 —
      // so no timing difference survives to distinguish missing from expired from exhausted.
      await padTo(deps.timers, startedAt, deps.limits.redeemConstantMs);
      return outcome.ok ? ok({ status: "active", needsInviteCode: false }) : errorResponse(outcome.error);
    }),

    // Lets the code screen say "redemption is paused" instead of making the player guess after a
    // 503. Readable by a pending account, like the code screen itself.
    //
    // `attemptsRemaining` (R192) is how many more tries this account has in §9.4 step 2's window,
    // so the screen can say so before a try is spent. It counts this profile's attempts only:
    // another account's attempts from the same address never change it, because reporting them
    // would tell this caller about the other accounts behind its address. The `+ 1` is config.ts's
    // reading of step 2's strict "more than": the count excludes the attempt being made, so attempt
    // `redeemPerProfilePerHour + 2` is the first refused. It is advisory — the per-IP window can
    // still refuse sooner on a shared network, and that refusal arrives as a 429 with its wait.
    //
    // `attemptsRetryAfterMs` (R192) is how long until an account with no tries left gets one back:
    // its oldest counted attempt leaves the window then. 0 while it has tries. The screen shows the
    // wait and reads the status again when it runs out, so "no tries left" lifts by itself. Like the
    // count, it is this profile's own: the per-IP window's wait would describe other accounts.
    route("GET", "/api/codes/status", "user", async (req, deps) => {
      const now = deps.timers.now();
      const open = now < breaker.openUntil;
      const since = now - deps.limits.redeemWindowMs;
      const profileId = req.profile?.id ?? null;
      const attempts = profileId === null ? 0 : await deps.store.codes.countAttemptsByProfile(profileId, since);
      const attemptsRemaining = Math.max(0, deps.limits.redeemPerProfilePerHour + 1 - attempts);
      let attemptsRetryAfterMs = 0;
      if (attemptsRemaining === 0 && profileId !== null) {
        const oldest = await deps.store.codes.oldestAttemptAtByProfile(profileId, since);
        attemptsRetryAfterMs = oldest === null ? 0 : Math.max(0, oldest + deps.limits.redeemWindowMs - now);
      }
      return ok({
        redemptionEnabled: !open,
        retryAfterMs: open ? breaker.openUntil - now : 0,
        attemptsRemaining,
        attemptsRetryAfterMs,
      });
    }),
  ];
}
