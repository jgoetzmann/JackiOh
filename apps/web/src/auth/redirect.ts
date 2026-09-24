// Emailed auth links, read once and scrubbed (R193).
//
// A confirmation or recovery email links to `/login` (`authRedirectUrl`), and GoTrue's implicit
// flow appends the session to the URL FRAGMENT: `#access_token=…&refresh_token=…&expires_at=…&
// type=signup`. A link that failed (mail scanners prefetch links and spend one-time tokens) comes
// back with `error`, `error_code` and `error_description`, in the fragment, the query, or both.
//
// Before this module the client ignored all of it and left the tokens in the address bar and in
// history. Now:
//
//   - `parseAuthRedirect` reads a URL into one of four outcomes. It is pure, and it never reads
//     `error_description`: provider text is never shown, a known error code maps to our sentence.
//   - `consumeAuthRedirect` reads `window.location` and, if any auth parameter is present, drops the
//     query and the fragment with `history.replaceState` BEFORE returning, so the tokens are gone
//     before anything renders. The result is cached, so React StrictMode's second call (which sees
//     the already-scrubbed URL) gets the same answer.
//   - A recovery session is held HERE, for this tab only (memory, and `sessionStorage` so a reload or
//     a phone discarding the tab does not spend the reset; never `localStorage`), and becomes the
//     stored session only once a new password is saved (`/reset-password`). Closing the tab forgets
//     it here (`/login` renewed it on arrival, so the refresh token the link's URL carried is spent
//     already), and leaving the reset screen unsaved abandons it (`abandonRecoverySession`, which
//     also revokes it at the provider, renewing it first if its access token has run out).
//
// A LINK'S ADDRESS IS A CLAIM, NOT A FACT. `email` below is read from the access token's payload
// without checking its signature, and anyone can write a link. What a `session` or `recovery`
// outcome may do is `/login`'s decision, and `/login` acts on the address only once the server has
// accepted the token (see `routes/login.tsx`). Nothing here chooses a destination either; every
// navigation after an auth link goes to a `paths` value.

import { revokeSignedOutSession } from "../net/auth.ts";
import type { Session } from "../net/session.ts";

/** The session-bearing link types GoTrue sends besides `recovery`. */
export type SessionLinkType = "signup" | "invite" | "magiclink" | "email_change";

export type AuthRedirect =
  | { kind: "none" }
  | { kind: "session"; session: Session; email: string | null; linkType: SessionLinkType }
  | { kind: "recovery"; session: Session; email: string | null }
  | { kind: "error"; failure: "linkExpired" | "linkDenied" };

/** Every parameter GoTrue's implicit flow may put on a link. Any of them present means scrub. */
const AUTH_PARAMETERS: readonly string[] = [
  "access_token",
  "refresh_token",
  "expires_at",
  "expires_in",
  "token_type",
  "type",
  "error",
  "error_code",
  "error_description",
];

const SESSION_TYPES: ReadonlySet<string> = new Set<SessionLinkType>(["signup", "invite", "magiclink", "email_change"]);

function isSessionLinkType(type: string): type is SessionLinkType {
  return SESSION_TYPES.has(type);
}

const NONE: AuthRedirect = { kind: "none" };

function fragmentParams(url: URL): URLSearchParams {
  return new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
}

function hasAuthParameter(params: URLSearchParams): boolean {
  return AUTH_PARAMETERS.some((name) => params.has(name));
}

function positiveNumber(raw: string | null): number | null {
  if (raw === null || raw.trim().length === 0) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** One string claim of an access token's payload, base64url-decoded and NEVER verified. */
function tokenClaim(token: string, name: "email" | "sub" | "session_id"): string | null {
  const parts = token.split(".");
  const payload = parts[1];
  if (payload === undefined || payload.length === 0) return null;
  try {
    const base64 = payload.replace(/-/gu, "+").replace(/_/gu, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof claims !== "object" || claims === null) return null;
    const value = (claims as Record<string, unknown>)[name];
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * The `email` claim of an access token's payload, base64url-decoded and NEVER verified: anyone can
 * write a token whose payload names any address. So it is only a claim. A link's address is acted
 * on only once the server has accepted the token (`/login`), and a stored session's address is
 * only ever shown back to the player who holds it.
 */
export function emailFromToken(token: string): string | null {
  return tokenClaim(token, "email");
}

/**
 * The `sub` claim (the account's user id), NEVER verified. Worth reading only for a token the
 * provider or the server has already accepted, such as a stored session's, to tell whether a
 * renewal handed back the same account (`net/gate.ts`).
 */
export function subjectFromToken(token: string): string | null {
  return tokenClaim(token, "sub");
}

/**
 * The `session_id` claim (the provider's session the token belongs to), NEVER verified. Read only
 * for tokens this browser already holds, to tell a renewal of the same session (the refresh token
 * rotated) from a new sign-in (`net/gate.ts`).
 */
export function sessionIdFromToken(token: string): string | null {
  return tokenClaim(token, "session_id");
}

/** One source (the fragment, or the query) read on its own. */
function readParams(params: URLSearchParams): AuthRedirect {
  // An error outranks any token beside it. `error_description` is never read.
  const errorCode = params.get("error_code");
  if (params.has("error") || errorCode !== null) {
    return { kind: "error", failure: errorCode === "otp_expired" ? "linkExpired" : "linkDenied" };
  }

  const accessToken = params.get("access_token");
  const type = params.get("type");
  if (accessToken === null || accessToken.length === 0 || type === null) return NONE;
  if (type !== "recovery" && !isSessionLinkType(type)) return NONE;

  const refreshToken = params.get("refresh_token");
  const session: Session = {
    accessToken,
    refreshToken: refreshToken !== null && refreshToken.length > 0 ? refreshToken : null,
    expiresAt: null,
  };
  // The expiry is counted on THIS device's clock: `expires_in` from now. `expires_at` is the
  // provider's clock, and every reader compares `expiresAt` with `Date.now()`, so on a device an
  // hour fast it read a session the provider had just issued as already expired. It is only the
  // fallback, for a link that carries no `expires_in`.
  const expiresAt = positiveNumber(params.get("expires_at"));
  const expiresIn = positiveNumber(params.get("expires_in"));
  if (expiresIn !== null) {
    session.expiresAt = Date.now() + expiresIn * 1000;
  } else if (expiresAt !== null) {
    session.expiresAt = expiresAt * 1000;
  }

  const email = emailFromToken(accessToken);
  if (isSessionLinkType(type)) return { kind: "session", session, email, linkType: type };
  return { kind: "recovery", session, email };
}

/**
 * Pure (bar `Date.now()` for an `expires_in`-only link). Reads the fragment and then the query: the
 * first of the two that yields anything decides.
 */
export function parseAuthRedirect(url: URL): AuthRedirect {
  const fromFragment = readParams(fragmentParams(url));
  if (fromFragment.kind !== "none") return fromFragment;
  return readParams(url.searchParams);
}

let consumed: AuthRedirect | null = null;

/**
 * Parses `window.location`. If any recognised auth parameter is present in the query or the
 * fragment, it calls `history.replaceState(null, "", pathname)` -- dropping both -- before it
 * returns (R193). The result is cached, so a second call (StrictMode) returns the same value until
 * `clearConsumedAuthRedirect()`. A URL with nothing to consume is simply `none` and caches nothing.
 */
export function consumeAuthRedirect(): AuthRedirect {
  if (consumed !== null) return consumed;

  const url = new URL(window.location.href);
  if (!hasAuthParameter(fragmentParams(url)) && !hasAuthParameter(url.searchParams)) return NONE;

  const result = parseAuthRedirect(url);
  try {
    window.history.replaceState(null, "", url.pathname);
  } catch {
    // A sandboxed frame may refuse; the tokens are still never rendered or stored from here.
  }
  consumed = result;
  return result;
}

export function clearConsumedAuthRedirect(): void {
  consumed = null;
}

/**
 * R193 on every path. Supabase falls back to the project's Site URL whenever a `redirect_to` misses
 * its allow-list, and emails sent from the dashboard (an invite, a recovery) always use it, so a
 * link can land on `/` or anywhere else with a live refresh token in its fragment. Called once at
 * boot, before the route switch and before anything renders: if the address bar holds any auth
 * parameter, the link is consumed (read, cached, scrubbed from the address bar and history) at
 * once, `/login` included. `/login`'s own screen is a lazily loaded chunk, and waiting for it left
 * the tokens in the address bar while it loaded, and there for good (a "Reload" included) when it
 * failed to load. A link on any other path is then moved to `loginPathname`, where `/login` applies
 * its checks exactly as for a link that landed there. Returns whether it moved.
 */
export function adoptAuthRedirect(loginPathname: string): boolean {
  if (typeof window === "undefined") return false;
  const url = new URL(window.location.href);
  if (!hasAuthParameter(fragmentParams(url)) && !hasAuthParameter(url.searchParams)) return false;
  consumeAuthRedirect();
  if (url.pathname === loginPathname) return false; // already scrubbed; `/login` reads the cache
  try {
    window.history.replaceState(null, "", loginPathname);
  } catch {
    return false;
  }
  return true;
}

// --- the recovery session, for this tab only ------------------------------------------------------
//
// In memory, and mirrored to `sessionStorage`, which belongs to this one tab and dies with it. The
// mirror is what lets the reset survive a reload, or a phone discarding the backgrounded tab while
// the player is in a password manager: the link cannot be opened a second time. It is never written
// to `localStorage`, where every tab (and the next person at a shared computer) would find it.

export const RECOVERY_STORAGE_KEY = "jackioh.auth.recovery";

export type HeldRecovery = { session: Session; email: string | null };

let recovery: HeldRecovery | null = null;

function writeRecoveryMirror(value: HeldRecovery | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null) window.sessionStorage.removeItem(RECOVERY_STORAGE_KEY);
    else window.sessionStorage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Blocked storage: the memory copy still serves this page; a reload asks for a new link.
  }
}

/** The mirror, read as untrusted input: anything but a session with an access token is nothing. */
function readRecoveryMirror(): HeldRecovery | null {
  if (typeof window === "undefined") return null;
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(RECOVERY_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as { session?: unknown; email?: unknown } | null;
    const session = value?.session as { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown } | undefined;
    if (typeof session?.accessToken !== "string" || session.accessToken.length === 0) return null;
    return {
      session: {
        accessToken: session.accessToken,
        refreshToken: typeof session.refreshToken === "string" ? session.refreshToken : null,
        expiresAt: typeof session.expiresAt === "number" ? session.expiresAt : null,
      },
      email: typeof value?.email === "string" ? value.email : null,
    };
  } catch {
    return null;
  }
}

/** Keep a recovery link's session for `/reset-password`, in this tab only. */
export function holdRecoverySession(session: Session, email: string | null): void {
  recovery = { session, email };
  writeRecoveryMirror(recovery);
}

/**
 * The held recovery session, or null. One whose access token has expired is dropped only when it
 * cannot be renewed: with a refresh token, the reset screen renews it before the new password is
 * sent (R194), and the provider is the one to say whether the reset still stands.
 */
export function recoverySession(): HeldRecovery | null {
  const held = recovery ?? readRecoveryMirror();
  if (held === null) return null;
  const expiresAt = held.session.expiresAt;
  const renewable = typeof held.session.refreshToken === "string" && held.session.refreshToken.length > 0;
  if (!renewable && typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
    releaseRecoverySession();
    return null;
  }
  recovery = held;
  return held;
}

/**
 * Forget it, without revoking: after a save, when it has become the stored session. A scheduled
 * abandonment is called off too, since nothing is held any more for it to abandon.
 */
export function releaseRecoverySession(): void {
  cancelScheduledAbandon();
  recovery = null;
  writeRecoveryMirror(null);
}

/**
 * The player left the reset without saving: forget the session and revoke it at the provider, so
 * nobody who comes to this tab later (the Back button on a shared computer) finds a working "choose
 * a new password" form for the account, and no token of it works any more. The form stays open past
 * the access token's hour (the save renews it), so an expired one is renewed first and then
 * revoked (`revokeSignedOutSession`, R194): the provider refuses to revoke with an expired access
 * token, and the refresh token would have stayed live. Best effort, never throws.
 */
export function abandonRecoverySession(): void {
  const held = recovery ?? readRecoveryMirror();
  releaseRecoverySession();
  if (held !== null) void revokeSignedOutSession(held.session);
}

let scheduledAbandon: ReturnType<typeof setTimeout> | null = null;

/**
 * The reset screen unmounted without saving: abandon the session once the current task is over,
 * unless the screen takes it back first (`keepRecoverySession`). React's StrictMode unmounts and
 * remounts every screen once in development, and that rehearsal must not revoke a live reset.
 */
export function abandonRecoverySessionSoon(): void {
  cancelScheduledAbandon();
  scheduledAbandon = setTimeout(() => {
    scheduledAbandon = null;
    abandonRecoverySession();
  }, 0);
}

/** The reset screen is (still) showing the held session: a scheduled abandonment is called off. */
export function keepRecoverySession(): void {
  cancelScheduledAbandon();
}

function cancelScheduledAbandon(): void {
  if (scheduledAbandon === null) return;
  clearTimeout(scheduledAbandon);
  scheduledAbandon = null;
}
