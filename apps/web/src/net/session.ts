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
