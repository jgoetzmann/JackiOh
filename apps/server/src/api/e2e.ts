/**
 * BUILD M8's `E2E=1` test server: the fixture accounts, the fixture invite codes, the auth
 * provider that honours them and R144's reseed at boot.
 *
 * BUILD M8's preamble: "Cypress runs against `apps/web` in `E2E=1` mode (hotseat route and a test
 * server with fixture accounts)." `e2e/README.md`'s assumption A6 spells out which accounts:
 * "fixture accounts `e2e-p1`, `e2e-p2` (active, own every card) and `e2e-pending` (pending,
 * verified email); seeded invite codes — one good, one missing, one expired, one exhausted."
 *
 * SPEC §11 R144: "In end-to-end mode the server reseeds its fixture accounts and invite codes at
 * boot, so a spec that activates the pending account or spends an invite code is repeatable.
 * Without this the invite-gate spec passes once and fails on every later run, which is
 * indistinguishable from a regression." Spec 10 does exactly that: it flips `e2e-pending` to
 * active and spends the good code.
 *
 * NOTHING HERE IS REACHABLE IN PRODUCTION. `src/index.ts` builds these only when `env.E2E` is
 * true, and `src/env.ts` already refuses `E2E` together with `NODE_ENV=production`:
 *
 *     "E2E: must not be set together with NODE_ENV=production — BUILD M8's fixture accounts and
 *      seeded games must never be reachable in a production deployment."
 *
 * THE VALUES BELOW ARE A CONTRACT WITH `e2e/support/config.ts`, which is the suite's own source of
 * truth and cannot be imported from here (`e2e/` is its own pnpm root and this package's tsconfig
 * covers only `src` and `test`). They are transcribed from its defaults. That file also lets CI
 * override every one of them (`--expose p1Token=…`, `--expose goodCode=…`); an override with no
 * matching change here would seed one set and ask for another, so the two move together.
 */

import { INVITE_CODE_LENGTH } from "../config";
import { isWellFormedCode, normalizeCode } from "./crypto";
import { ApiError } from "./http";
import type { E2EStore } from "./e2e-store";
import type { AuthProvider, AuthSession, AuthUser, InviteCode, ServerDeps } from "./ports";

// ---------------------------------------------------------------------------
// Fixture accounts (`e2e/support/config.ts`, `accounts`)
// ---------------------------------------------------------------------------

export type E2EAccount = {
  /** The managed-auth user id. `profiles.user_id` is resolved from it, as in production. */
  userId: string;
  email: string;
  password: string;
  /** The static bearer token this account's requests carry. */
  token: string;
  /** What `profiles.status` must be once the reseed is done (§9.4). */
  status: "pending" | "active";
};

/**
 * §9.4 makes a verified email a precondition of redemption ("reject unless the account is pending
 * with a verified email"), and spec 10 asserts `emailVerified === true` on the *pending* account
 * before it redeems. So all three fixtures are verified; what distinguishes `e2e-pending` is its
 * `profiles.status`, which is the only thing §9.4's gate reads.
 */
export const E2E_ACCOUNTS: readonly E2EAccount[] = [
  {
    userId: "e2e-p1",
    email: "e2e-p1@jackioh.test",
    password: "e2e-p1-password",
    token: "e2e-token-p1",
    status: "active",
  },
  {
    userId: "e2e-p2",
    email: "e2e-p2@jackioh.test",
    password: "e2e-p2-password",
    token: "e2e-token-p2",
    status: "active",
  },
  {
    userId: "e2e-pending",
    email: "e2e-pending@jackioh.test",
    password: "e2e-pending-password",
    token: "e2e-token-pending",
    status: "pending",
  },
];

// ---------------------------------------------------------------------------
// Fixture invite codes (`e2e/support/config.ts`, `inviteCodes`)
// ---------------------------------------------------------------------------

/**
 * One code per §9.4 failure mode plus one that works. `missing` is the one that must NOT exist:
 * seeding it would turn spec 10's "missing" sample into an "already used" sample and the three
 * kinds would stop being the three kinds.
 */
export type E2EInviteCodeKind = "good" | "missing" | "expired" | "exhausted";

export const E2E_INVITE_CODES: Readonly<Record<E2EInviteCodeKind, string>> = {
  good: "ABCD-EFGH-JKMN-PQRS",
  missing: "ZZZZ-ZZZZ-ZZZZ-ZZZZ",
  expired: "XPRD-XPRD-XPRD-XPRD",
  exhausted: "XHST-XHST-XHST-XHST",
};

/**
 * Not in SPEC, and no R-row: a fixture value with no consequence. Any past instant makes the code
 * expired, which is all R144's reseed needs; the rule it exercises is §9.4 step 5's rejection.
 */
const EXPIRED_CODE_AGE_MS = 60 * 60 * 1000;

/**
 * Not in SPEC, and no R-row: the fixtures take the default rather than choosing. `max_uses` of one
 * matches `DEFAULT_INVITE_CODE_MAX_USES` in `codes.ts` — where the proposed ruling for that default
 * is written out — and the db agent's `max_uses int not null default 1`, so the exhausted fixture
 * is exhausted at one use. Restating the number is all this does; it decides nothing.
 */
const FIXTURE_CODE_MAX_USES = 1;

// ---------------------------------------------------------------------------
// The auth provider
// ---------------------------------------------------------------------------

/**
 * Not in SPEC, and no R-row: wording only, and only inside the test mode. §9.2 puts sign-up in the
 * browser against the auth provider itself, and R144's fixture mode has three accounts and no way
 * to mint a fourth, so this sentence tells whoever wrote the spec which mode they are in. No
 * production path can reach it.
 */
const SIGN_UP_UNAVAILABLE_MESSAGE =
  "This server is running BUILD M8's fixture auth: it has a fixed set of test accounts and cannot create one.";

function authUserOf(account: E2EAccount): AuthUser {
  return {
    userId: account.userId,
    email: account.email,
    // §9.4 step 1's precondition. `appMetadata` stays empty: nothing here is an authorization
    // claim, and `profiles.status` remains the only authority on what an account may do.
    emailVerified: true,
    appMetadata: {},
  };
}

function sessionOf(account: E2EAccount): AuthSession {
  return {
    accessToken: account.token,
    refreshToken: null,
    expiresAt: null,
    user: authUserOf(account),
  };
}

/**
 * The `AuthProvider` BUILD M8's fixture accounts sign in with. `verifyAccessToken` maps each
 * static token in `e2e/support/config.ts` to its account and everything else to null;
 * `signInWithPassword` accepts the fixture email/password pairs.
 *
 * It is a *replacement* for `createSupabaseAuth`, never a fallback beside it: `src/index.ts`
 * chooses one or the other on `env.E2E`, so a real token cannot reach this provider and a fixture
 * token cannot reach the real one.
 */
export function createE2EAuth(accounts: readonly E2EAccount[] = E2E_ACCOUNTS): AuthProvider {
  const byToken = new Map<string, E2EAccount>();
  const byEmail = new Map<string, E2EAccount>();
  for (const account of accounts) {
    byToken.set(account.token, account);
    byEmail.set(account.email.toLowerCase(), account);
  }

  return {
    verifyAccessToken: async (token) => {
      const account = byToken.get(token);
      return account === undefined ? null : authUserOf(account);
    },

    signUp: async () => {
      throw new ApiError("unavailable", SIGN_UP_UNAVAILABLE_MESSAGE);
    },

    signInWithPassword: async (email, password) => {
      const account = byEmail.get(email.trim().toLowerCase());
      // A plain `Error`, not an `ApiError`: `auth.ts`'s `callProvider` turns it into the one
      // 401 whose wording never distinguishes "no such account" from "wrong password".
      if (account === undefined || account.password !== password) {
        throw new Error("invalid login credentials");
      }
      return sessionOf(account);
    },
  };
}

// ---------------------------------------------------------------------------
// R144: the reseed
// ---------------------------------------------------------------------------

export type E2ESeedSummary = {
  /** userId -> the profile id the reseed created, for the boot log. */
  profiles: Record<string, string>;
  /** How many cards R111's launch grant handed each active fixture. */
  grantedCards: number;
  /** The kinds actually written to `invite_codes`; `missing` is never among them. */
  codes: E2EInviteCodeKind[];
};

/**
 * R144. Wipes every row and rewrites the fixtures, so running it twice leaves exactly the state
 * running it once does: `e2e-pending` pending again, the good code unspent again, spec 10
 * repeatable.
 *
 * The accounts are created `pending` and then flipped with `profiles.setStatus`, which is where
 * `e2e-store.ts` carries R111's `pending → active` trigger — so "own every card" is produced by
 * the same grant a redemption produces, not by a seeding shortcut that could disagree with it.
 */
export async function seedE2EFixtures(
  deps: ServerDeps,
  store: E2EStore,
  options: { accounts?: readonly E2EAccount[]; codes?: Readonly<Record<E2EInviteCodeKind, string>> } = {},
): Promise<E2ESeedSummary> {
  const accounts = options.accounts ?? E2E_ACCOUNTS;
  const codes = options.codes ?? E2E_INVITE_CODES;
  const now = deps.timers.now();

  assertFixtureCodesAreRedeemable(codes);

  store.reset();

  const profiles: Record<string, string> = {};
  let grantedCards = 0;
  for (const account of accounts) {
    const profile = await store.profiles.create({
      userId: account.userId,
      email: account.email,
      rating: deps.config.eloStart,
      at: now,
    });
    profiles[account.userId] = profile.id;
    if (account.status === "active") {
      await store.profiles.setStatus(profile.id, "active");
      grantedCards = store.grantsFor(profile.id).length;
    }
  }

  const written: E2EInviteCodeKind[] = [];
  for (const kind of ["good", "expired", "exhausted"] as const) {
    await store.codes.insert(inviteCodeFor(deps, kind, codes[kind], now));
    written.push(kind);
  }

  deps.log.info("e2e.fixtures.seeded", {
    profiles,
    grantedCards,
    codes: written,
    // The plaintext of a fixture code is not a secret — it is checked into `e2e/support/config.ts`
    // — but it is still never logged, so nothing teaches an operator that logging one is normal.
    missingCodeIsAbsent: true,
  });

  return { profiles, grantedCards, codes: written };
}

function inviteCodeFor(
  deps: ServerDeps,
  kind: Exclude<E2EInviteCodeKind, "missing">,
  plain: string,
  now: number,
): InviteCode {
  // §9.4: "stored hashed". `hashes.code` normalises (upper case, separators dropped) before
  // hashing, exactly as `resolveCode` in codes.ts does on the way in, so a typed
  // `abcd efgh jkmn pqrs` finds the same row as `ABCD-EFGH-JKMN-PQRS`.
  const base: InviteCode = {
    id: deps.ids.uuid(),
    codeHash: deps.hashes.code(plain),
    maxUses: FIXTURE_CODE_MAX_USES,
    uses: 0,
    revoked: false,
    expiresAt: null,
    createdAt: now,
  };
  if (kind === "expired") return { ...base, expiresAt: now - EXPIRED_CODE_AGE_MS };
  if (kind === "exhausted") return { ...base, uses: FIXTURE_CODE_MAX_USES };
  return base;
}

/**
 * A fixture code that `codes.ts` would reject as *malformed* would still answer §9.4's identical
 * error, so spec 10 would stay green while testing nothing — the good code included. Checked at
 * boot, loudly, against the same predicate redemption uses.
 */
function assertFixtureCodesAreRedeemable(
  codes: Readonly<Record<E2EInviteCodeKind, string>>,
): void {
  const seen = new Map<string, E2EInviteCodeKind>();
  for (const [kind, plain] of Object.entries(codes) as [E2EInviteCodeKind, string][]) {
    const normalized = normalizeCode(plain);
    if (!isWellFormedCode(normalized, INVITE_CODE_LENGTH)) {
      throw new Error(
        `the ${kind} end-to-end invite code is not a code §9.4 would mint: ` +
          `${String(INVITE_CODE_LENGTH)} characters from CODE_ALPHABET (R104) are required`,
      );
    }
    const clash = seen.get(normalized);
    if (clash !== undefined) {
      throw new Error(
        `the ${kind} and ${clash} end-to-end invite codes are the same code; spec 10 needs four distinct ones`,
      );
    }
    seen.set(normalized, kind);
  }
}
