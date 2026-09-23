// Where the browser keeps its access token, and nothing else.
//
// CLAUDE.md rule 7: the client sends intent and renders `viewFor`. A session is not game state —
// it is the bearer token every request and the match socket carry, so it lives in one module that
// knows how to read it, write it and clear it, and no screen reaches into `localStorage` itself.
//
// STORAGE, NOT IN-PAGE STATE. `e2e/cypress/e2e/05-reconnect.cy.ts` calls `cy.reload()` mid-match
// and requires the session to survive it, so the token is read from `localStorage` on every boot.
//
// THE KEY IS A CONTRACT. The M8 specs seed a session by writing
// `localStorage["jackioh.e2e.session"] = JSON.stringify({ accessToken })` in `onBeforeLoad`
// (`visitAs` in specs 05, 06, 09 and 10). The specs are fixed, so that key is read here verbatim;
// `jackioh.session` is the name a real sign-in writes and is preferred when both are present.
// This is an ASSUMPTION beyond BUILD (e2e/README.md A6), made in exactly one place.
//
// Two more keys live here, `jackioh.auth.pendingEmail` and `jackioh.auth.pendingReset`: the address
// a sign-up in this browser is waiting to confirm, and the one it asked to reset (see the section at
// the end). A recovery session never touches `localStorage`; `auth/redirect.ts` holds it for this
// tab only until a new password is saved (R193).

import { AUTH_PENDING_ADDRESS_TTL_SECONDS } from "../../../server/src/config.ts";

/** What a sign-in writes. Preferred when both keys are set. */
export const SESSION_STORAGE_KEY = "jackioh.session";

/** What the M8 specs write in `onBeforeLoad`. Read-only as far as the client is concerned. */
export const E2E_SESSION_STORAGE_KEY = "jackioh.e2e.session";

const KEYS: readonly string[] = [SESSION_STORAGE_KEY, E2E_SESSION_STORAGE_KEY];

export type Session = {
  accessToken: string;
  /** Present when a real sign-in produced it; the M8 fixture sessions carry neither. */
  refreshToken?: string | null;
  expiresAt?: number | null;
};

/**
 * External, untrusted input: a hand-edited `localStorage` value must not crash the boot. Anything
 * that is not `{ accessToken: <non-empty string> }` is simply not a session.
 */
function parse(raw: string | null): Session | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const token = (value as { accessToken?: unknown }).accessToken;
  if (typeof token !== "string" || token.length === 0) return null;
  const session: Session = { accessToken: token };
  const refresh = (value as { refreshToken?: unknown }).refreshToken;
  if (typeof refresh === "string" || refresh === null) session.refreshToken = refresh;
  const expires = (value as { expiresAt?: unknown }).expiresAt;
  if (typeof expires === "number" || expires === null) session.expiresAt = expires;
  return session;
}

/** The current session, or null when nobody is signed in. Never throws. */
export function readSession(): Session | null {
  if (typeof window === "undefined") return null;
  for (const key of KEYS) {
    let raw: string | null;
    try {
      raw = window.localStorage.getItem(key);
    } catch {
      // A private window or blocked site data: there is simply no session.
      return null;
    }
    const session = parse(raw);
    if (session !== null) return session;
  }
  return null;
}

export function writeSession(session: Session): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Nothing to do: the caller gets a session that lasts until the tab closes.
  }
}

export function clearSession(): void {
  if (typeof window === "undefined") return;
  for (const key of KEYS) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // As above.
    }
  }
}

// --- the sign-up and the reset this browser started (R193) --------------------------------------
//
// A sign-up (and a resend) remembers its address here. It signs nothing in: no confirmation link
// ever signs the browser in (R193), not even this sign-up's, because an address someone else
// registered first keeps their password through it. The address only keys this browser's own hints
// ("open the confirmation link first") and the provider's mail interval for it (R192).
//
// The reset address beside it IS a guard: a recovery link is held only for the address this browser
// asked to reset (below). It is an address, not a secret, and nothing trusts it for more than that
// comparison. Because it arms the comparison, it is kept only as long as an emailed link can live
// (`AUTH_PENDING_ADDRESS_TTL_SECONDS`), every sign-in and sign-out forgets both addresses (one left
// behind, or planted on a shared computer, must not accept someone else's link later), and neither
// is ever filled into a form.

export const PENDING_EMAIL_STORAGE_KEY = "jackioh.auth.pendingEmail";

/**
 * The guard for a RECOVERY link: the address this browser asked to reset. Without it, a reset link
 * an attacker requested for their own account and sent on would sign the victim's browser into the
 * attacker's account, over the victim's own session.
 */
export const PENDING_RESET_STORAGE_KEY = "jackioh.auth.pendingReset";

/** What each key holds: the address, and when it was remembered (epoch ms). */
type RememberedAddress = { address: string; at: number };

function rememberAddress(key: string, email: string): void {
  if (typeof window === "undefined") return;
  const trimmed = email.trim();
  if (trimmed.length === 0) return;
  const value: RememberedAddress = { address: trimmed, at: Date.now() };
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Blocked storage: the link will ask the player to sign in instead, which is still correct.
  }
}

/** What each key holds, as read back: the address, and when it was remembered (epoch ms). */
export type PendingAddress = { readonly address: string; readonly at: number };

/**
 * The address and when it was remembered, or null when there is none, it is past
 * `AUTH_PENDING_ADDRESS_TTL_SECONDS`, or the value is anything but what `rememberAddress` writes (a
 * bare string from an older build included).
 */
function rememberedEntry(key: string): PendingAddress | null {
  if (typeof window === "undefined") return null;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { address, at } = value as { address?: unknown; at?: unknown };
  if (typeof address !== "string" || typeof at !== "number" || !Number.isFinite(at)) return null;
  const age = Date.now() - at;
  if (age < 0 || age > AUTH_PENDING_ADDRESS_TTL_SECONDS * 1000) {
    forgetAddress(key);
    return null;
  }
  const trimmed = address.trim();
  return trimmed.length === 0 ? null : { address: trimmed, at };
}

function rememberedAddress(key: string): string | null {
  return rememberedEntry(key)?.address ?? null;
}

function forgetAddress(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // As above.
  }
}

/** Set on a sign-up and on a confirmation resend. */
export function rememberPendingEmail(email: string): void {
  rememberAddress(PENDING_EMAIL_STORAGE_KEY, email);
}

/** The address a sign-up in this browser is waiting on, or null. Never throws. */
export function pendingEmail(): string | null {
  return rememberedAddress(PENDING_EMAIL_STORAGE_KEY);
}

/**
 * The pending sign-up's address and when it was mailed (a sign-up or a resend), so a reload still
 * waits out the provider's per-address interval that send started (R192).
 */
export function pendingEmailEntry(): PendingAddress | null {
  return rememberedEntry(PENDING_EMAIL_STORAGE_KEY);
}

/** On a confirmation link for this sign-up: the address is confirmed, so its hints are over. */
export function forgetPendingEmail(): void {
  forgetAddress(PENDING_EMAIL_STORAGE_KEY);
}

/** Set when this browser asks for a password reset link. */
export function rememberPendingReset(email: string): void {
  rememberAddress(PENDING_RESET_STORAGE_KEY, email);
}

/** The address this browser last asked to reset, or null. Never throws. */
export function pendingReset(): string | null {
  return rememberedAddress(PENDING_RESET_STORAGE_KEY);
}

/** The pending reset's address and when it was asked for, for the same interval (R192). */
export function pendingResetEntry(): PendingAddress | null {
  return rememberedEntry(PENDING_RESET_STORAGE_KEY);
}

/** Once a new password is saved. */
export function forgetPendingReset(): void {
  forgetAddress(PENDING_RESET_STORAGE_KEY);
}

/**
 * Both addresses, on every sign-in and sign-out: whatever this browser was waiting on is over, and
 * an address left armed would accept a link meant for someone else (R193).
 */
export function forgetPendingAddresses(): void {
  forgetPendingEmail();
  forgetPendingReset();
}
