// PKCE for the emailed links (R323, R324): the confirmation, its resend, and the password reset.
//
// GoTrue's implicit flow put a session's tokens in the link's URL fragment (`#access_token=…`), where
// history, a shared screen or a referrer could see them. With PKCE the request that mails a link
// carries `code_challenge` (the SHA-256 of a random verifier, base64url) and
// `code_challenge_method: "s256"`; the link then comes back to `/login?code=…`, and only the browser
// holding the verifier can turn that code into a session (`net/auth.ts` `exchangeAuthCode`, at
// `/auth/v1/token?grant_type=pkce`). No token is ever in a URL.
//
// The verifier is kept in `localStorage`, inside try/catch like every store here: a confirmation
// link is usually opened in a new tab, and `sessionStorage` would not reach it. One verifier per
// kind of link (`signup`, which a resend reuses so the first email's link keeps working, and
// `recovery`), each with the time it was made, so the newest is tried first. A code that comes back
// with no verifier here was asked for on another device or browser (R324), which the caller says in
// its own words. A verifier is forgotten once its code has been exchanged.
//
// A verifier on its own grants nothing: the one-time code from the email is needed too, and that
// code is worth nothing without it. Nothing here is ever shown or read from a URL.

/** Where the verifiers live (R323). */
export const PKCE_STORAGE_KEY = "jackioh.auth.pkce";
/** The stored value's shape version: anything else reads as no verifier. */
const PKCE_STORAGE_VERSION = 1;
/** RFC 7636 §4.1: a verifier is 43 to 128 characters; 64 random bytes are 86 in base64url. */
export const PKCE_VERIFIER_BYTES = 64;
const PKCE_VERIFIER_MIN_LENGTH = 43;
const PKCE_VERIFIER_MAX_LENGTH = 128;
/** What the challenge is: SHA-256 of the verifier, base64url (GoTrue spells it lower case). */
export const PKCE_METHOD = "s256";

/** Which emailed link a verifier is for. */
export type PkceFlow = "signup" | "recovery";

const FLOWS: readonly PkceFlow[] = ["signup", "recovery"];

type Stored = { verifier: string; at: number };
type StoredValue = { v: number } & Partial<Record<PkceFlow, Stored>>;

/** What a request that mails a link sends beside the address. */
export type PkceChallenge = { code_challenge: string; code_challenge_method: typeof PKCE_METHOD };

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]+$/u;

function isVerifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= PKCE_VERIFIER_MIN_LENGTH &&
    value.length <= PKCE_VERIFIER_MAX_LENGTH &&
    VERIFIER_PATTERN.test(value)
  );
}

/** A fresh random verifier (RFC 7636 §4.1). */
export function newVerifier(): string {
  const bytes = new Uint8Array(PKCE_VERIFIER_BYTES);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** RFC 7636 §4.2 S256: base64url(SHA-256(verifier)). */
export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** The stored verifiers, read as untrusted input: anything malformed is no verifier. */
function readStored(): StoredValue {
  const empty: StoredValue = { v: PKCE_STORAGE_VERSION };
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(PKCE_STORAGE_KEY);
  } catch {
    return empty;
  }
  if (raw === null) return empty;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return empty;
    const record = parsed as Record<string, unknown>;
    if (record.v !== PKCE_STORAGE_VERSION) return empty;
    const value: StoredValue = { v: PKCE_STORAGE_VERSION };
    for (const flow of FLOWS) {
      const entry = record[flow] as { verifier?: unknown; at?: unknown } | undefined;
      if (entry === undefined || entry === null || typeof entry !== "object") continue;
      if (!isVerifier(entry.verifier)) continue;
      value[flow] = { verifier: entry.verifier, at: typeof entry.at === "number" && Number.isFinite(entry.at) ? entry.at : 0 };
    }
    return value;
  } catch {
    return empty;
  }
}

function writeStored(value: StoredValue): void {
  try {
    if (FLOWS.every((flow) => value[flow] === undefined)) window.localStorage.removeItem(PKCE_STORAGE_KEY);
    else window.localStorage.setItem(PKCE_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Blocked storage: the link still confirms the address; the code just cannot be exchanged
    // here, which reads as a link opened elsewhere (R324).
  }
}

/**
 * The challenge to send with a request that mails a `flow` link, remembering its verifier. A new
 * verifier each time, except that a resend of the confirmation reuses the sign-up's (`reuse`), so
 * the link in the first email still works once the second has been sent.
 */
export async function challengeForRequest(flow: PkceFlow, options: { reuse?: boolean } = {}): Promise<PkceChallenge> {
  const kept = options.reuse === true ? readStored()[flow]?.verifier : undefined;
  const verifier = kept ?? newVerifier();
  // Hashed before it is kept: a browser that cannot hash sends no challenge and keeps nothing.
  const challenge = await challengeFor(verifier);
  const stored = readStored();
  stored[flow] = { verifier, at: Date.now() };
  writeStored(stored);
  return { code_challenge: challenge, code_challenge_method: PKCE_METHOD };
}

/** The verifiers this browser holds, newest first: the order to try a returning code with. */
export function storedVerifiers(): { flow: PkceFlow; verifier: string }[] {
  const stored = readStored();
  return FLOWS.flatMap((flow) => {
    const entry = stored[flow];
    return entry === undefined ? [] : [{ flow, verifier: entry.verifier, at: entry.at }];
  })
    .sort((a, b) => b.at - a.at)
    .map(({ flow, verifier }) => ({ flow, verifier }));
}

/** The verifier for `flow` has been used (its code exchanged): forget it. */
export function forgetVerifier(flow: PkceFlow): void {
  const stored = readStored();
  delete stored[flow];
  writeStored(stored);
}
