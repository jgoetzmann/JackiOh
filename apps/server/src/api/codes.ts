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
 * Two consequences of §9.4's ordering, which the code below depends on:
 *
 *  - Steps 2 and 3 reject *before* step 4, so a rate-limited attempt is not itself logged. The
 *    window therefore drains: a caller who is already over the limit cannot keep their own
 *    counter pinned by retrying, and the cheap checks run before anything touches the code table.
 *  - Because of that, a rejection must be **returned**, never thrown out of the transaction: a
 *    throw would roll back the attempt row step 4 requires, and the next attempt would see a
 *    shorter history than it should.
 *
 * Every number here comes from `deps.limits` (filled from `src/config.ts` by `defaultLimits()`)
 * and every constant from `../config`. Nothing in this file restates a value from SPEC.
 */

import { INVITE_CODE_LENGTH, REDEMPTION_IDENTICAL_ERROR } from "../config";
import { formatCode, isWellFormedCode, normalizeCode } from "./crypto";
import { ApiError, errorResponse, ok, padTo, route, str, type ApiRequest, type Route } from "./http";
import type { CodeAttemptResult, InviteCode, Profile, ServerDeps } from "./ports";

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
 * Mints one code: `INVITE_CODE_LENGTH` characters (§9.4's 80 bits over the 32-symbol alphabet),
 * formatted `XXXX-XXXX-XXXX-XXXX` for display, stored **hashed** and never in plaintext. The
 * plaintext is returned exactly once, to whoever asked for it; nothing persists it.
 */
export async function mintInviteCode(
  deps: ServerDeps,
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

/** What the transaction decided, including the operator-only reason for `code_attempts`. */
type Attempt = { outcome: RedeemOutcome; result: CodeAttemptResult; reason: string };

export async function redeemCode(deps: ServerDeps, input: RedeemInput): Promise<RedeemOutcome> {
  const breaker = input.breaker ?? createBreakerState();
  const now = deps.timers.now();

  // §9.4's circuit breaker, checked before step 1: while it is open nothing touches the profile,
  // the attempt log or the code table, which is the point of having it.
  if (now < breaker.openUntil) {
    return { ok: false, error: new ApiError("unavailable", BREAKER_MESSAGE) };
  }

  // §9.4: "Redemption is one server-side transaction". Steps 1-6 all run inside it.
  const outcome = await deps.store.tx(async (t): Promise<RedeemOutcome> => {
    // ---- Step 1: "reject unless the account is pending with a verified email" ----------------
    // Re-read inside the transaction: the profile handed in was resolved before it opened, and a
    // concurrent redemption may already have flipped it.
    const profile = await t.profiles.getById(input.profile.id);
    if (profile === null) {
      return { ok: false, error: new ApiError("unauthorized", "sign in first") };
    }
    if (profile.status === "banned") {
      return { ok: false, error: new ApiError("account_banned", BANNED_MESSAGE) };
    }
    if (profile.status === "active") {
      // Not a code failure — §9.4 only makes redemption the pending → active transition, so an
      // active account asking again is a conflict, and it is told so plainly.
      return { ok: false, error: new ApiError("conflict", ALREADY_ACTIVE_MESSAGE) };
    }
    if (!input.emailVerified) {
      return { ok: false, error: new ApiError("email_unverified", EMAIL_UNVERIFIED_MESSAGE) };
    }

    const since = now - deps.limits.redeemWindowMs;

    // ---- Step 2: "reject if this profile made more than 5 attempts in the last hour" ---------
    // Strictly `>`: config.ts spells out that the 6th attempt is the first rejection.
    const byProfile = await t.codes.countAttemptsByProfile(profile.id, since);
    if (byProfile > deps.limits.redeemPerProfilePerHour) {
      return { ok: false, error: new ApiError("rate_limited", RATE_LIMITED_MESSAGE) };
    }

    // ---- Step 3: "reject if this IP hash made more than 20" ----------------------------------
    const byIp = await t.codes.countAttemptsByIp(input.ipHash, since);
    if (byIp > deps.limits.redeemPerIpPerHour) {
      return { ok: false, error: new ApiError("rate_limited", RATE_LIMITED_MESSAGE) };
    }

    const attempt = await resolveCode(deps, t, { ...input, profileId: profile.id }, now);

    // ---- Step 4: "log the attempt either way" ------------------------------------------------
    // Written last, with the outcome steps 5 and 6 produced, because `CodeStore` (ports.ts) has
    // only `logAttempt` — there is no way to write a row now and flip its result later, the way
    // the db agent's SQL does with an UPDATE of its own row. Since this is the *same*
    // transaction, the two orders commit identically and nothing outside can tell them apart;
    // what matters, and what holds, is that every attempt which got past steps 2 and 3 is
    // logged, whether the code turned out to be good or not.
    await t.codes.logAttempt({
      profileId: input.profile.id,
      ipHash: input.ipHash,
      result: attempt.result,
      reason: attempt.reason,
      at: now,
    });

    return attempt.outcome;
  });

  if (!outcome.ok) await noteFailure(deps, breaker, now);
  return outcome;
}

/**
 * Steps 5 and 6. Returns the outcome instead of throwing, so the attempt row step 4 owes is never
 * rolled back by a rejection (see this file's header).
 */
async function resolveCode(
  deps: ServerDeps,
  t: { codes: ServerDeps["store"]["codes"]; profiles: ServerDeps["store"]["profiles"] },
  input: { plainCode: string; profileId: string },
  now: number,
): Promise<Attempt> {
  const reject = (reason: string): Attempt => ({
    outcome: { ok: false, error: identicalCodeError() },
    result: "rejected",
    reason,
  });

  // ---- Step 5: "look up by hash and reject if revoked, expired or exhausted" -----------------
  const normalized = normalizeCode(input.plainCode);
  // A malformed code (wrong length, or a character outside the alphabet) takes the identical
  // path: no oracle distinguishes "well formed but unknown" from "could never be a code".
  if (!isWellFormedCode(normalized, INVITE_CODE_LENGTH)) return reject("malformed");

  const code = await t.codes.findByHash(deps.hashes.code(normalized));
  if (code === null) return reject("missing");
  if (code.revoked) return reject("revoked");
  if (code.expiresAt !== null && code.expiresAt <= now) return reject("expired");
  if (code.uses >= code.maxUses) return reject("exhausted");

  // ---- Step 6: "increment uses and set the account active, atomically" ----------------------
  // `claim` is the atomic increment (ports.ts: "Two concurrent callers cannot both win the last
  // use"), so a false return is a code that ran out between the check above and here.
  const claimed = await t.codes.claim(code.id, now);
  if (!claimed) return reject("exhausted");

  await t.profiles.setStatus(input.profileId, "active");
  return { outcome: { ok: true }, result: "ok", reason: "redeemed" };
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
      plainCode: str(req.body, "code"),
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
    route("GET", "/api/codes/status", "user", async (_req, deps) => {
      const now = deps.timers.now();
      const open = now < breaker.openUntil;
      return ok({
        redemptionEnabled: !open,
        retryAfterMs: open ? breaker.openUntil - now : 0,
      });
    }),
  ];
}
