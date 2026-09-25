// SPEC §9.4's gate, as the client renders it.
//
// The gate is the SERVER's: every endpoint but `/api/auth/me` and `/api/codes/*` is declared
// `auth: "active"` and answers 403 `account_pending` to anyone else. This module enforces nothing
// (CLAUDE.md rule 7) — it reads `GET /api/auth/me`, which is the endpoint §9.4 provides precisely
// so "the client knows to show the code screen", and reports what it said. A screen that renders
// on a `pending` account is a UX mistake, not a security hole: the data it would need is already
// refused at the door.
//
// §9.4: "A pending account can log in, verify its email and see the code screen, and nothing
// else." So `/decks`, `/play` and `/match/<id>` send a pending account to `/invite`, and an
// account with no session at all to `/login`.
//
// RENEWAL (R194). An access token lasts an hour. The refresh token that came with it used to be
// stored and never read, so an hour after signing in every screen quietly sent the player back to
// `/login`. Now the gate renews ONCE, in two cases: the stored token is within
// `AUTH_SESSION_REFRESH_MARGIN_SECONDS` of expiring, or `/api/auth/me` answers 401. It writes the
// new session and reads `/api/auth/me` again. A renewal the provider refuses ends the session, and
// the account comes back `anonymous` with reason `expired` so the sign-in screen can say so rather
// than failing silently. A renewal that could not reach the provider (`network`, `service`) keeps
// the session and reports an error with a retry. A session with no refresh token (the e2e
// fixtures) is never renewed and behaves exactly as before.
//
// ANOTHER TAB. The session lives in `localStorage`, which every tab shares, so a sign-out (or a
// renewal) in one tab changes what this one holds. `useAccount` listens for that (`storage`
// events fire only in the OTHER tabs) and reads the account again, so a signed-out device is not
// shown a gated screen from a token that is already gone.
//
// THE BACK BUTTON. Sign-out leaves by a real page load, but browsers keep the page it left in the
// back/forward cache, frozen with the account it had read, and a frozen page hears no `storage`
// event. So a page restored from that cache (`pageshow` with `persisted`) reads the account again,
// and a signed-out device is sent to sign in instead of being handed the old screen.
//
// A RENEWAL OUTLIVED BY ITS SESSION. A renewal is a round trip, and the device can sign out (here or
// in another tab), or sign in as someone else, while it is out. So storage is read again when the
// provider answers: a renewal is written back only over the very session it renewed. And it must
// hand back the SAME account: a refresh token answers with the session of whoever owns it,
// whatever access token came with it, so a renewal naming another user id ends the session instead.
//
// A TOKEN THAT STAYS FRESH UNDER AN OPEN SCREEN (R194). The gate hands its token down, and a screen
// can stay open for longer than the token lives (a queue wait, an hour in the deckbuilder). So
// while a screen is open the gate renews `AUTH_SESSION_REFRESH_MARGIN_SECONDS` before the token it
// handed down expires, and hands down the new one. A sleeping tab's timers are frozen, so the page
// coming back into view checks the clock at once.
//
// A RE-READ IN THE BACKGROUND KEEPS THE SCREEN. Once a screen is open, the re-reads above (another
// tab, the back/forward cache, a renewal) must not tear it down for nothing:
//   - one that fails (a blip, a sleeping server) keeps the account the screen already has, unless
//     the device has moved to another account meanwhile. Only the player's own "Try again" (which
//     starts from "loading") shows the error panel.
//   - one that finds the same session renewed keeps the token the screen already holds while that
//     token still has more than the margin to live: it is as good as the new one (same session),
//     and a screen that keys something live on it (the match socket) would be torn down and
//     reopened for nothing.

import { useEffect, useRef, useState } from "react";

import {
  AUTH_SESSION_REFRESH_MARGIN_SECONDS,
  AUTH_SESSION_RENEWAL_FLOOR_SECONDS,
} from "../../../server/src/config.ts";
import { sessionIdFromToken, subjectFromToken } from "../auth/redirect.ts";
import { ApiRequestError, getMe, retryAfterMsOf, type MeResponse } from "./api.ts";
import { AuthError, authConfig, refreshSession, revokeSession, sessionNearExpiry } from "./auth.ts";
import {
  E2E_SESSION_STORAGE_KEY,
  SESSION_STORAGE_KEY,
  clearSession,
  readSession,
  writeSession,
  type Session,
} from "./session.ts";

export type Account =
  /** The `/api/auth/me` round trip has not answered yet. */
  | { kind: "loading" }
  /**
   * No session in storage, or the server refused the token. `reason: "expired"` means a renewal
   * the provider refused just ended the session (R194), and the session has been cleared.
   */
  | { kind: "anonymous"; reason?: "expired" }
  /**
   * The server or the provider could not be reached, or answered something unexpected. `retry`
   * runs the read again without a page load (the gate's `gate-retry`). `retryAfterMs` is the wait a
   * rate limit stated (R192), which the gate counts down before it offers `retry`.
   */
  | { kind: "error"; message: string; retry?: () => void; retryAfterMs?: number }
  | {
      kind: "ready";
      token: string;
      me: MeResponse;
      /** When `token` expires (epoch ms, this device's clock), when the session says. */
      expiresAt?: number | null;
      /** The session has a refresh token, so the gate can keep `token` fresh (R194). */
      renewable?: boolean;
    };

/** `me.profile.status`, hoisted so a screen does not reach through two objects for it. */
export function statusOf(account: Account): "loading" | "anonymous" | "error" | MeResponse["profile"]["status"] {
  return account.kind === "ready" ? account.me.profile.status : account.kind;
}

/** The refresh token when this session can be renewed at all, else null. */
function renewableToken(session: Session): string | null {
  const token = session.refreshToken;
  if (typeof token !== "string" || token.length === 0) return null;
  // A build with no provider configured cannot renew anything; it behaves as it always did.
  if (authConfig() === null) return null;
  return token;
}

function isUnauthorized(cause: unknown): boolean {
  return cause instanceof ApiRequestError && cause.status === 401;
}

/** What the gate says for R109's API limit; the wait is counted down beside it (R192). */
export const GATE_RATE_LIMITED_MESSAGE = "Too many requests from this account or network. Wait a moment, then try again.";

/**
 * The error's own sentence: a transport failure's is already a plain one (`ApiUnreachableError`),
 * and any other refusal is the server's, as it always was. A rate limit gets our sentence and its
 * wait, which the gate counts down before it offers to try again (R192).
 */
function errorAccount(cause: unknown, retry: () => void): Account {
  if (cause instanceof ApiRequestError && (cause.status === 429 || cause.code === "rate_limited")) {
    const wait = retryAfterMsOf(cause);
    return {
      kind: "error",
      message: GATE_RATE_LIMITED_MESSAGE,
      retry,
      ...(wait === null ? {} : { retryAfterMs: wait }),
    };
  }
  return { kind: "error", message: cause instanceof Error ? cause.message : String(cause), retry };
}

type Renewal = { ok: true; session: Session } | { ok: false; account: Account };

/** Two tokens that both name a user id, and not the same one. */
function differentAccounts(a: string, b: string): boolean {
  const first = subjectFromToken(a);
  const second = subjectFromToken(b);
  return first !== null && second !== null && first !== second;
}

/**
 * One renewal. The new session is written even if the screen that asked has since unmounted: the
 * provider has already rotated the refresh token, and dropping the new one would strand the player.
 *
 * `stale` is the session this read started from. If storage already holds a different one, another
 * screen renewed in the meantime (its request settled before this one's 401 came back, so the
 * single flight in `refreshSession` could not merge them). Spending `stale`'s refresh token now
 * would be a reuse, which the provider treats as theft, so the stored session is used instead.
 *
 * Storage is read again once the provider answers (see A RENEWAL OUTLIVED BY ITS SESSION):
 *   - empty: the device signed out meanwhile. Nothing is written, the renewed session is revoked
 *     (sign-out's own revocation may have used the tokens it held), and the account is anonymous.
 *   - another session: someone signed in (or renewed) meanwhile, and that session stands.
 *   - still `stale`: the renewal is written, unless it is another account's (then the session ends).
 */
async function renew(stale: Session, refreshToken: string, retry: () => void): Promise<Renewal> {
  const stored = readSession();
  if (stored === null) return { ok: false, account: { kind: "anonymous" } };
  if (stored.accessToken !== stale.accessToken) return { ok: true, session: stored };
  try {
    const session = await refreshSession(refreshToken);
    const now = readSession();
    if (now === null) {
      void revokeSession(session.accessToken);
      return { ok: false, account: { kind: "anonymous" } };
    }
    if (now.accessToken !== stale.accessToken) return { ok: true, session: now };
    if (differentAccounts(stale.accessToken, session.accessToken)) {
      clearSession();
      void revokeSession(session.accessToken);
      return { ok: false, account: { kind: "anonymous", reason: "expired" } };
    }
    writeSession(session);
    return { ok: true, session };
  } catch (cause) {
    if (cause instanceof AuthError && cause.failure === "sessionEnded") {
      // Only the session this renewal was for: one signed in meanwhile is not this one's to end.
      const now = readSession();
      if (now === null || now.accessToken === stale.accessToken) clearSession();
      return { ok: false, account: { kind: "anonymous", reason: "expired" } };
    }
    return { ok: false, account: errorAccount(cause, retry) };
  }
}

/** The account a session and its `/api/auth/me` answer make. */
function readyAccount(session: Session, me: MeResponse): Account {
  return {
    kind: "ready",
    token: session.accessToken,
    me,
    expiresAt: typeof session.expiresAt === "number" && Number.isFinite(session.expiresAt) ? session.expiresAt : null,
    renewable: renewableToken(session) !== null,
  };
}

async function resolveAccount(retry: () => void): Promise<Account> {
  let session = readSession();
  if (session === null) return { kind: "anonymous" };

  let renewed = false;
  const early = renewableToken(session);
  if (early !== null && sessionNearExpiry(session, Date.now())) {
    const renewal = await renew(session, early, retry);
    if (!renewal.ok) return renewal.account;
    session = renewal.session;
    renewed = true;
  }

  try {
    const me = await getMe(session.accessToken);
    return readyAccount(session, me);
  } catch (cause) {
    if (!isUnauthorized(cause)) return errorAccount(cause, retry);
  }

  // `/api/auth/me` said 401. A token the provider no longer accepts is the same as having none,
  // unless there is a refresh token that has not been spent yet on this read.
  const late = renewed ? null : renewableToken(session);
  if (late === null) return { kind: "anonymous" };

  const renewal = await renew(session, late, retry);
  if (!renewal.ok) return renewal.account;
  try {
    const me = await getMe(renewal.session.accessToken);
    return readyAccount(renewal.session, me);
  } catch (cause) {
    // Renewed once already; a second 401 is the ordinary "sign in again".
    if (isUnauthorized(cause)) return { kind: "anonymous" };
    return errorAccount(cause, retry);
  }
}

/** Fired by `announceAccountChange`; every mounted `useAccount` reads the account again. */
const ACCOUNT_CHANGED = "jackioh:account-changed";

/**
 * Tells every screen in this tab that the account or its session changed under it: a request of a
 * screen's own renewed the session, or the server answered as if the account's status had moved on
 * (a redemption refused because another tab already redeemed). Each `useAccount` reads it again.
 */
export function announceAccountChange(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(ACCOUNT_CHANGED));
}

export type UnauthorizedOutcome =
  /** The session was renewed (here or already elsewhere): retry once with `token`. */
  | { kind: "renewed"; token: string }
  /** The session is over: sign in again. `expired` when the provider refused the renewal (R194). */
  | { kind: "signedOut"; expired: boolean }
  /**
   * The device is now signed in as another account (another tab signed in meanwhile). Nothing is
   * retried: a request made for one account is never sent again as another.
   */
  | { kind: "switched" }
  /** The provider could not be reached; the session is kept. */
  | { kind: "failed" };

/** `renewed`, unless the session to retry with belongs to another account than `token` did. */
function renewedAs(token: string, next: string): UnauthorizedOutcome {
  return differentAccounts(token, next) ? { kind: "switched" } : { kind: "renewed", token: next };
}

/**
 * R194 for a request a screen makes itself (the gate covers `/api/auth/me`): the API refused
 * `token` as unauthorised, so the stored session is renewed once, sharing the provider call with
 * any renewal already in flight, and the request can be retried with the new token.
 */
export async function renewAfterUnauthorized(token: string): Promise<UnauthorizedOutcome> {
  const session = readSession();
  if (session === null) return { kind: "signedOut", expired: false };
  // Someone renewed while this request was out: retry with what storage holds now.
  if (session.accessToken !== token) return renewedAs(token, session.accessToken);
  const refreshToken = renewableToken(session);
  if (refreshToken === null) return { kind: "signedOut", expired: false };
  const renewal = await renew(session, refreshToken, () => undefined);
  if (renewal.ok) return renewedAs(token, renewal.session.accessToken);
  if (renewal.account.kind === "anonymous") {
    return { kind: "signedOut", expired: renewal.account.reason === "expired" };
  }
  return { kind: "failed" };
}

/**
 * What `callWithRenewal` hands back: the call's answer, the news that the session is over, or that
 * the device has moved to another account (every screen has been told to read it again).
 */
export type RenewedCall<T> =
  | { kind: "ok"; value: T }
  | { kind: "signedOut"; expired: boolean }
  | { kind: "switched" };

/**
 * R194 for one of a screen's own requests: `call` with `token`, and if the API refuses it as
 * unauthorised, renew once (`renewAfterUnauthorized`) and call again with the new token. Every
 * screen in this tab is told the session changed, so each reads the renewed one. A refusal that is
 * not a 401, or a renewal that could not reach the provider, is thrown as the call's own error.
 */
export async function callWithRenewal<T>(token: string, call: (token: string) => Promise<T>): Promise<RenewedCall<T>> {
  try {
    return { kind: "ok", value: await call(token) };
  } catch (cause) {
    if (!isUnauthorized(cause)) throw cause;
    const renewal = await renewAfterUnauthorized(token);
    if (renewal.kind === "signedOut") return { kind: "signedOut", expired: renewal.expired };
    if (renewal.kind === "failed") throw cause;
    announceAccountChange();
    if (renewal.kind === "switched") return { kind: "switched" };
    return { kind: "ok", value: await call(renewal.token) };
  }
}

/** Two tokens of the same provider session (a renewal rotated it), when both name one. */
function sameSession(a: string, b: string): boolean {
  const first = sessionIdFromToken(a);
  return first !== null && first === sessionIdFromToken(b);
}

/** A ready account whose token is within the renewal margin of expiring (or past it). */
function tokenNearExpiry(account: Extract<Account, { kind: "ready" }>, now: number): boolean {
  const expiresAt = account.expiresAt;
  return typeof expiresAt === "number" && expiresAt - now <= AUTH_SESSION_REFRESH_MARGIN_SECONDS * 1000;
}

/**
 * What a read of the account leaves on screen, given what is there now (see A RE-READ IN THE
 * BACKGROUND KEEPS THE SCREEN). A first read and the player's own retry start from `loading`, so
 * they always show what they found.
 */
export function settleAccount(previous: Account, next: Account, now: number): Account {
  if (previous.kind !== "ready") return next;
  if (next.kind === "error") {
    // A background re-read failed. The screen stays for the account it was opened for, unless the
    // device now holds another account's session (or none, which reads as anonymous, not error).
    const stored = readSession();
    if (stored !== null && !differentAccounts(previous.token, stored.accessToken)) return previous;
    return next;
  }
  if (
    next.kind === "ready" &&
    next.token !== previous.token &&
    next.me.profile.id === previous.me.profile.id &&
    sameSession(previous.token, next.token) &&
    !tokenNearExpiry(previous, now)
  ) {
    // The same session, renewed elsewhere: the token the screen holds is as good for a while yet.
    return { ...next, token: previous.token, expiresAt: previous.expiresAt ?? null };
  }
  return next;
}

/** `setTimeout`'s own ceiling (a signed 32-bit millisecond count); a longer wait fires at once. */
const LONGEST_TIMER_MS = 2_147_483_647;

/**
 * R194 while a screen is open: re-read (and so renew) the account when the token it handed down
 * comes within `AUTH_SESSION_REFRESH_MARGIN_SECONDS` of expiring. A timer, and the page coming back
 * into view, since a sleeping tab's timers are frozen. A token that is already due (it came due
 * between the read and now) is renewed at once, but never more often than once per
 * `AUTH_SESSION_RENEWAL_FLOOR_SECONDS`, so a provider that issues tokens shorter-lived than the
 * margin cannot set off a loop of renewals.
 */
function useRenewalBeforeExpiry(account: Account, reread: () => void): void {
  const renewAt =
    account.kind === "ready" && account.renewable === true && typeof account.expiresAt === "number"
      ? account.expiresAt - AUTH_SESSION_REFRESH_MARGIN_SECONDS * 1000
      : null;
  const lastRenewal = useRef<number | null>(null);

  useEffect(() => {
    if (renewAt === null) return;
    const earliest = (): number =>
      Math.max(renewAt, lastRenewal.current === null ? 0 : lastRenewal.current + AUTH_SESSION_RENEWAL_FLOOR_SECONDS * 1000);
    // No once-only guard: a renewal that failed keeps the account (and so this effect) as it was,
    // and the page coming back into view may try again, never sooner than the floor allows.
    let timer: number | undefined;
    const schedule = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(fire, Math.min(Math.max(0, earliest() - Date.now()), LONGEST_TIMER_MS));
    };
    // A timer measures from the event loop's cached clock, which a long task leaves behind the
    // wall clock, so it can come due a little before `Date.now()` says: then it waits out the rest
    // rather than dropping the renewal until the page is next woken.
    function fire(): void {
      if (Date.now() < earliest()) {
        schedule();
        return;
      }
      lastRenewal.current = Date.now();
      reread();
    }
    const onWake = (): void => {
      if (document.visibilityState !== "hidden") fire();
    };
    schedule();
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    window.addEventListener("pageshow", onWake);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("pageshow", onWake);
    };
  }, [renewAt, reread]);
}

/**
 * Reads the session, renews it if it needs renewing, then reads `/api/auth/me`. One read per mount
 * (and one more per `retry`, per change the device's session goes through, and before the token it
 * handed down expires); the result is the only thing a screen needs to decide whether to render
 * itself or hand over to the gate.
 */
export function useAccount(): Account {
  const [attempt, setAttempt] = useState(0);
  const [account, setAccount] = useState<Account>({ kind: "loading" });
  const [reread] = useState(() => (): void => {
    setAttempt((count) => count + 1);
  });

  useRenewalBeforeExpiry(account, reread);

  useEffect(() => {
    let cancelled = false;
    const retry = (): void => {
      setAccount({ kind: "loading" });
      setAttempt((count) => count + 1);
    };

    resolveAccount(retry)
      .then((next) => {
        if (!cancelled) setAccount((previous) => settleAccount(previous, next, Date.now()));
      })
      .catch((cause: unknown) => {
        if (!cancelled) setAccount((previous) => settleAccount(previous, errorAccount(cause, retry), Date.now()));
      });

    // Another tab signed out, signed in or renewed: read the account again. What is on screen
    // stays until the new answer arrives, so a renewal elsewhere does not flash "Checking…".
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== null && event.key !== SESSION_STORAGE_KEY && event.key !== E2E_SESSION_STORAGE_KEY) return;
      setAttempt((count) => count + 1);
    };
    const onChanged = (): void => {
      setAttempt((count) => count + 1);
    };
    // Restored from the back/forward cache: the account read before it was frozen may be gone.
    const onPageShow = (event: PageTransitionEvent): void => {
      if (event.persisted) setAttempt((count) => count + 1);
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(ACCOUNT_CHANGED, onChanged);
    window.addEventListener("pageshow", onPageShow);

    return () => {
      cancelled = true;
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(ACCOUNT_CHANGED, onChanged);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [attempt]);

  return account;
}
