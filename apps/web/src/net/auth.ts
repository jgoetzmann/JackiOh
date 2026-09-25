// The browser's own arrow to the auth provider. SPEC §9.2 draws two separate arrows out of the
// browser -- `B -->|HTTPS| A[Auth provider]` and `B -->|HTTPS| F[API functions]` -- and this
// module is the first of them. The server never brokers a password: it verifies the token that
// comes back (`apps/server/src/api/auth.ts`, JWKS + `jose`), which is why its own
// `/api/auth/signin` answers 503 with "sign up and sign in against Supabase Auth from the client".
//
// NOT IN BUILD. No BUILD task names a client sign-in: M6-T1's files are all server-side, and the
// M8 suite never signs in through the UI (it seeds `localStorage` per e2e/README.md A6). SPEC §9.2
// has the arrow, so the design is settled even though the work order skipped it.
//
// NO `@supabase/supabase-js`. A handful of requests against GoTrue's REST API need no SDK, and an
// SDK would actively fight this codebase: it persists its own session to `localStorage` under its
// own key, while `net/session.ts` owns that storage and its key is a contract with the M8 specs.
// One `fetch` each keeps the token flowing through `writeSession` exactly as before.
//
// GoTrue reference, all authenticated with the publishable key in the `apikey` header:
//   POST /auth/v1/token?grant_type=password        sign in
//   POST /auth/v1/signup?redirect_to=...           sign up (mails a confirmation link)
//   POST /auth/v1/resend?redirect_to=...           mail the confirmation link again
//   POST /auth/v1/recover?redirect_to=...          mail a password-reset link
//   POST /auth/v1/token?grant_type=pkce            an emailed link's code, for a session (R323)
//   PUT  /auth/v1/user                             set a new password (Bearer: the recovery token)
//   POST /auth/v1/token?grant_type=refresh_token   renew a session (R194)
//   POST /auth/v1/logout?scope=local               revoke this session's refresh token (R194)
//
// EMAILED LINKS CARRY A CODE, NOT TOKENS (R323). The three mailers send a PKCE challenge
// (`auth/pkce.ts`), so a link comes back as `/login?code=…` and `exchangeAuthCode` turns the code
// into a session with the verifier this browser kept. A browser that cannot hash (no `crypto.subtle`
// outside a secure context) sends no challenge and gets the implicit flow's link, which
// `auth/redirect.ts` still reads, as it does a link mailed before the switch (R324).
//
// NO PROVIDER TEXT EVER REACHES THE SCREEN. Every refusal is reduced to an `AuthFailure` by
// `classifyProviderRefusal`, which reads only the status and the machine-readable error code, and
// each failure has one sentence of our own in `AUTH_MESSAGES`. GoTrue's `msg`, `error_description`
// and `message` are never read: they name facts (such as "Email not confirmed") that would make a
// refusal an account-existence oracle (R160), and they are attacker-influenced text besides.

import {
  AUTH_EMAIL_RESEND_COOLDOWN_SECONDS,
  AUTH_PROVIDER_TIMEOUT_SECONDS,
  AUTH_SESSION_REFRESH_MARGIN_SECONDS,
} from "../../../server/src/config.ts";
import { challengeForRequest, forgetVerifier, storedVerifiers, type PkceChallenge, type PkceFlow } from "../auth/pkce.ts";
import { paths } from "./navigate.ts";
import {
  forgetPendingAddresses,
  readSession,
  rememberPendingEmail,
  rememberPendingReset,
  writeSession,
  type Session,
} from "./session.ts";

// --- failures and their sentences --------------------------------------------------------------

/** Which provider call a refusal came from; the same answer means different things on each. */
export type AuthEndpoint = "signIn" | "signUp" | "resend" | "recover" | "updatePassword" | "refresh";

export type AuthFailure =
  | "credentials"
  | "signUpRefused"
  | "rateLimited"
  | "emailRateLimited"
  | "weakPassword"
  | "weakPasswordLength"
  | "weakPasswordCharacters"
  | "weakPasswordPwned"
  | "samePassword"
  | "passwordTooLong"
  | "signUpInvalid"
  | "invalidEmail"
  | "signupsClosed"
  | "linkExpired"
  | "sessionEnded"
  | "network"
  | "service"
  | "unconfigured";

/**
 * R160, the client half: "Sign-up and sign-in answer identically for every outcome that depends on
 * whether an account exists -- no such account, wrong password, already registered -- so neither
 * becomes an account-enumeration oracle... One error per endpoint, not one shared between them."
 *
 * So wrong password, unknown address and unconfirmed address are all `credentials`, and every
 * sign-up refusal that could hinge on an existing account is `signUpRefused`. The strings match
 * `SIGN_IN_FAILED_MESSAGE` and `SIGN_UP_FAILED_MESSAGE` in `apps/server/src/api/auth.ts`, so the
 * disabled server path and this one refuse in the same words.
 */
export const SIGN_IN_FAILED_MESSAGE = "That email and password do not match an account.";
export const SIGN_UP_FAILED_MESSAGE = "Could not create that account.";

export const AUTH_UNCONFIGURED_MESSAGE =
  "This build has no auth provider configured: set VITE_SUPABASE_URL and " +
  "VITE_SUPABASE_PUBLISHABLE_KEY in apps/web/.env (see apps/web/.env.example).";

/**
 * One sentence per failure. None of them depends on whether an account exists: a rate limit is
 * about the caller or the service (R192), a weak or reused password is about the password just
 * typed, and a closed sign-up is about this deployment.
 */
export const AUTH_MESSAGES: Readonly<Record<AuthFailure, string>> = {
  credentials: SIGN_IN_FAILED_MESSAGE,
  signUpRefused: SIGN_UP_FAILED_MESSAGE,
  rateLimited: "Too many attempts from this network. Wait a few minutes, then try again.",
  emailRateLimited: "We couldn't send an email just now. Wait a few minutes, then try again.",
  // The provider says WHY through `weak_password.reasons`; each reason has its own advice, and
  // none states a number, because the provider's minimum can be raised past this client's check.
  weakPassword: "That password is too weak. Choose a longer one that is harder to guess.",
  weakPasswordLength: "That password is too short. Choose a longer one.",
  weakPasswordCharacters:
    "That password needs more kinds of characters. Mix upper and lower case letters, digits and symbols.",
  weakPasswordPwned: "That password has appeared in a data breach. Choose one you haven't used anywhere else.",
  samePassword: "Choose a password different from your current one.",
  // The provider's `validation_failed`. On a new password it is the length, counted in bytes, so
  // neither sentence promises a number of characters.
  passwordTooLong: "That password is too long. Choose a shorter one.",
  signUpInvalid:
    "Check the email address and the password: one of them can't be used. A long password may be over the limit, so try a shorter one.",
  invalidEmail: "Enter a valid email address.",
  signupsClosed: "New accounts can't be created right now.",
  linkExpired: "That link has expired or was already used. Request a new one below.",
  sessionEnded: "Your session has ended. Sign in again.",
  network: "Couldn't reach the sign-in service. Check your connection and try again.",
  service: "The sign-in service had a problem. Try again in a minute.",
  unconfigured: AUTH_UNCONFIGURED_MESSAGE,
};

/** Unit conversion, not configuration. */
const SECONDS_PER_MINUTE = 60;

/**
 * The provider's per-address mail interval (`AUTH_EMAIL_RESEND_COOLDOWN_SECONDS`) in words: the
 * span ("minute", "2 minutes", "90 seconds") and how a sentence waits it out ("a minute").
 */
function mailInterval(): { span: string; wait: string } {
  const seconds = AUTH_EMAIL_RESEND_COOLDOWN_SECONDS;
  if (seconds % SECONDS_PER_MINUTE === 0) {
    const minutes = seconds / SECONDS_PER_MINUTE;
    if (minutes === 1) return { span: "minute", wait: "a minute" };
    return { span: `${String(minutes)} minutes`, wait: `${String(minutes)} minutes` };
  }
  return { span: `${String(seconds)} seconds`, wait: `${String(seconds)} seconds` };
}

const MAIL_INTERVAL = mailInterval();

/**
 * R192: the provider mails an address at most once per interval, and says so only to an address
 * that has an account, so the page cannot tell the player when a send was refused. It says when
 * one would be, for every address alike: a send asked for inside the interval (on another device,
 * or before a reload) does not go out.
 */
const MAIL_INTERVAL_NOTE =
  `If one went out in the last ${MAIL_INTERVAL.span}, from any device, this one can't: ` +
  `wait ${MAIL_INTERVAL.wait}, then ask again.`;

/** What the screens say when something went RIGHT (or, for the two mailers, might have). */
export const AUTH_NOTICES: Readonly<{
  signUpSent: string;
  resendSent: string;
  resetSent: string;
  emailConfirmed: string;
  sessionExpired: string;
  confirmFirst: string;
  checkingLink: string;
  checkingSlow: string;
  linkUnchecked: string;
  recoveryUnchecked: string;
  recoveryElsewhere: string;
  recoveryClaim: string;
  recoveryClaimMismatch: string;
  inviteNeedsPassword: string;
  inviteOnly: string;
}> = {
  // Identical for every address (R160): the provider mails nothing to an address that already has a
  // confirmed account, so the second sentence is the way on for a returning player.
  signUpSent:
    "Check your email for a confirmation link, then sign in. No email after a few minutes? You may already have an account: sign in, or reset your password.",
  resendSent: `If that address has an account waiting for confirmation, a new link is on its way. ${MAIL_INTERVAL_NOTE}`,
  resetSent: `If that address has an account, a reset link is on its way. ${MAIL_INTERVAL_NOTE}`,
  emailConfirmed: "Your email is confirmed. Sign in to continue.",
  sessionExpired: "Your session ended. Sign in again to continue.",
  // Keyed on this browser's own sign-up (`pendingEmail`), never on the provider's answer, so it
  // reveals nothing R160 hides.
  confirmFirst: "If you just created this account, open the confirmation link we emailed first.",
  checkingLink: "Checking your link…",
  // The gate's sentence for a sleeping server, and why to wait: a reset link works only once.
  checkingSlow:
    "This is taking a while. The server may be waking up, which can take up to a minute. Your link is still being checked, so keep this page open.",
  linkUnchecked:
    "We couldn't check that link just now. If your email is confirmed, sign in below; otherwise ask for a new link.",
  // A reset link is not a confirmation: nothing about signing in or confirmation emails helps.
  recoveryUnchecked:
    "We couldn't check your password reset link just now. Try again in a moment, or ask for a new reset link.",
  recoveryElsewhere:
    "That password reset link can't be used here. Each link works only once, so ask for a new one below.",
  // A reset asked for on another device or browser (R193): held once the player types the address
  // it was sent to. The address itself is never shown or filled in.
  recoveryClaim:
    "This reset link was asked for on another device or browser. To use it here, type your account's email address. If you didn't ask to reset your password, don't use this link.",
  recoveryClaimMismatch: "That isn't the address this reset link was sent to. Type your account's email address.",
  inviteNeedsPassword:
    "You've been invited. Your account needs a password before you can sign in: ask for a link to set one below.",
  inviteOnly: "Online play needs an invite code, which you enter after confirming your email.",
};

/**
 * A weak password's second and third reasons, said after the first: the provider names every rule
 * the password broke, and naming only one sent the player back for a second refusal.
 */
const WEAK_PASSWORD_ALSO: Readonly<Partial<Record<AuthFailure, string>>> = {
  weakPasswordCharacters: "It also needs more kinds of characters: mix upper and lower case letters, digits and symbols.",
  weakPasswordPwned: "It has also appeared in a data breach, so choose one you haven't used anywhere else.",
};

/**
 * A refusal from the auth provider (or from reaching it), already reduced to our own words. The
 * message is `failure`'s sentence, followed by one for each further weak-password reason.
 */
export class AuthError extends Error {
  readonly failure: AuthFailure;

  constructor(failure: AuthFailure, alsoFailed: readonly AuthFailure[] = []) {
    const also = alsoFailed.map((reason) => WEAK_PASSWORD_ALSO[reason]).filter((line) => line !== undefined);
    super([AUTH_MESSAGES[failure], ...also].join(" "));
    this.name = "AuthError";
    this.failure = failure;
  }
}

// --- classifying a refusal ---------------------------------------------------------------------

/** A refresh token or access token the provider no longer honours. */
const SESSION_CODES: ReadonlySet<string> = new Set([
  "bad_jwt",
  "session_expired",
  "session_not_found",
  "refresh_token_not_found",
  "refresh_token_already_used",
  "invalid_grant",
]);

const SIGNUP_CLOSED_CODES: ReadonlySet<string> = new Set(["signup_disabled", "email_provider_disabled"]);

/**
 * The machine-readable code: `error_code`, else `code` when it is a string (newer GoTrue sends a
 * NUMERIC `code` that is only the status again), else `error` (older GoTrue's OAuth-style field).
 * `msg`, `message` and `error_description` are never read.
 */
function providerCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as { error_code?: unknown; code?: unknown; error?: unknown };
  if (typeof record.error_code === "string" && record.error_code.length > 0) return record.error_code;
  if (typeof record.code === "string" && record.code.length > 0) return record.code;
  if (typeof record.error === "string" && record.error.length > 0) return record.error;
  return null;
}

/** GoTrue's `weak_password.reasons`, each as our failure, in this order of priority. */
const WEAK_PASSWORD_REASONS: ReadonlyArray<readonly [string, AuthFailure]> = [
  ["length", "weakPasswordLength"],
  ["characters", "weakPasswordCharacters"],
  ["pwned", "weakPasswordPwned"],
];

/**
 * Every reason in GoTrue's machine-readable `weak_password.reasons` that we know, in order of
 * priority (length, characters, pwned); the provider's accompanying text is never read.
 */
function weakPasswordFailures(body: unknown): AuthFailure[] {
  if (typeof body !== "object" || body === null) return [];
  const detail = (body as { weak_password?: unknown }).weak_password;
  if (typeof detail !== "object" || detail === null) return [];
  const reasons = (detail as { reasons?: unknown }).reasons;
  if (!Array.isArray(reasons)) return [];
  return WEAK_PASSWORD_REASONS.filter(([reason]) => reasons.includes(reason)).map(([, failure]) => failure);
}

/** The first weak-password reason; no reason, or none we know, is the plain `weakPassword`. */
function weakPasswordFailure(body: unknown): AuthFailure {
  return weakPasswordFailures(body)[0] ?? "weakPassword";
}

/** The endpoint's answer for "some other 4xx": its generic refusal. */
function genericRefusal(endpoint: AuthEndpoint): AuthFailure {
  switch (endpoint) {
    case "signIn":
      return "credentials";
    case "signUp":
      return "signUpRefused";
    case "resend":
    case "recover":
    case "updatePassword":
      return "service";
    case "refresh":
      return "sessionEnded";
  }
}

/**
 * Every provider answer maps to one `AuthFailure` (docs/polish/5-sign-in.md, the per-endpoint
 * table). The status is read first, so an unfamiliar error shape can only make a message less
 * specific, never leak one.
 *
 * Sign-in never gets anything finer than `credentials` for a 4xx that is not a rate limit: GoTrue's
 * `email_not_confirmed` against `invalid_credentials` is exactly the oracle R160 closes. `resend`
 * and `recover` never report `credentials` or `signUpRefused` either; `resendConfirmation` and
 * `requestPasswordReset` resolve on every provider answer but an invalid address (R192), so this
 * function's other answers for those two only matter to a direct caller.
 */
export function classifyProviderRefusal(endpoint: AuthEndpoint, status: number, body: unknown): AuthFailure {
  const code = providerCode(body);

  // R192: a rate limit is reported as a rate limit, never as the identical sign-in error.
  if (status === 429) {
    return endpoint === "signUp" && code === "over_email_send_rate_limit" ? "emailRateLimited" : "rateLimited";
  }
  if (status >= 500) return "service";

  if (code === "weak_password") {
    if (endpoint === "signIn") return "credentials";
    if (endpoint === "signUp" || endpoint === "updatePassword") return weakPasswordFailure(body);
    return genericRefusal(endpoint);
  }
  if (code === "same_password") {
    if (endpoint === "signIn") return "credentials";
    if (endpoint === "signUp") return "signUpRefused";
    if (endpoint === "updatePassword") return "samePassword";
    return genericRefusal(endpoint);
  }
  if (code === "validation_failed") {
    // Sign-in's refusal stays R160's one sentence; the other two are about what was just typed.
    if (endpoint === "updatePassword") return "passwordTooLong";
    if (endpoint === "signUp") return "signUpInvalid";
    return genericRefusal(endpoint);
  }
  if (code === "email_address_invalid") {
    if (endpoint === "signIn") return "credentials";
    if (endpoint === "signUp" || endpoint === "resend" || endpoint === "recover") return "invalidEmail";
    return genericRefusal(endpoint);
  }
  if (code !== null && SIGNUP_CLOSED_CODES.has(code)) {
    if (endpoint === "signIn") return "credentials";
    if (endpoint === "signUp") return "signupsClosed";
    if (endpoint === "resend" || endpoint === "recover") return "service";
    return genericRefusal(endpoint);
  }
  if (status === 401 || status === 403 || (code !== null && SESSION_CODES.has(code))) {
    if (endpoint === "updatePassword") return "linkExpired";
    return genericRefusal(endpoint);
  }
  return genericRefusal(endpoint);
}

/**
 * `classifyProviderRefusal` as the error a caller throws: a weak password's sentence goes on to name
 * every other reason the provider gave (`AuthError`), so one refusal says all there is to fix.
 */
export function providerRefusal(endpoint: AuthEndpoint, status: number, body: unknown): AuthError {
  const failure = classifyProviderRefusal(endpoint, status, body);
  const reasons = weakPasswordFailures(body);
  if (failure !== reasons[0]) return new AuthError(failure);
  return new AuthError(failure, reasons.slice(1));
}

// --- configuration -----------------------------------------------------------------------------

export type AuthConfig = { url: string; publishableKey: string };

/**
 * `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` (`apps/web/.env.example`). Both are
 * PUBLIC by construction -- Vite compiles a `VITE_`-prefixed value into the browser bundle -- and
 * the publishable key is the one that is safe there. `SUPABASE_SECRET_KEY` bypasses every RLS
 * policy and lives only in `apps/server/.env`; `SERVER_ONLY_ENV_VARS` and `PUBLIC_ENV_VARS` in
 * `apps/server/src/env.ts` are the two disjoint lists.
 *
 * Returns null rather than throwing, so a deployment that has not configured auth renders a
 * sentence saying so instead of a blank screen.
 */
export function authConfig(): AuthConfig | null {
  const url: unknown = import.meta.env.VITE_SUPABASE_URL;
  const publishableKey: unknown = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (typeof url !== "string" || url.length === 0) return null;
  if (typeof publishableKey !== "string" || publishableKey.length === 0) return null;
  return { url: url.replace(/\/+$/u, ""), publishableKey };
}

function requireConfig(): AuthConfig {
  const config = authConfig();
  if (config === null) throw new AuthError("unconfigured");
  return config;
}

/**
 * WHERE EVERY EMAILED LINK POINTS: `/login` on the origin that asked for it. GoTrue otherwise
 * builds links from the project's Site URL, which is still its default (`http://localhost:3000`),
 * so every email sent from the deployed site pointed at the reader's own machine.
 *
 * The value is built from `window.location.origin` and a fixed path, NEVER from anything typed or
 * found in a URL (B35). Supabase honours a `redirect_to` only when it matches the Site URL or the
 * project's Redirect URLs allow-list, and falls back to the Site URL otherwise, so this cannot point
 * an email at an attacker's domain either. `""` when there is no window (nothing to come back to).
 */
export function authRedirectUrl(): string {
  if (typeof window === "undefined") return "";
  return `${window.location.origin}${paths.login}`;
}

function withRedirect(path: string): string {
  const redirectTo = authRedirectUrl();
  return redirectTo === "" ? path : `${path}?redirect_to=${encodeURIComponent(redirectTo)}`;
}

/**
 * R323: the PKCE challenge a mailer sends, remembering its verifier (`auth/pkce.ts`). Nothing when
 * this browser cannot hash (no `crypto.subtle` outside a secure context) or cannot store: the
 * provider then mails an implicit-flow link, which still works (R324).
 */
async function pkceFields(flow: PkceFlow, reuse = false): Promise<PkceChallenge | Record<string, never>> {
  try {
    return await challengeForRequest(flow, { reuse });
  } catch {
    return {};
  }
}

// --- one request -------------------------------------------------------------------------------

type ProviderRequest = {
  method: "POST" | "PUT";
  path: string;
  body?: Record<string, unknown>;
  /** A session call carries the access token; an anonymous one carries the publishable key. */
  bearer?: string;
  keepalive?: boolean;
};

/**
 * Never throws a provider's text: a `fetch` that rejects is `network`, and the body is only data.
 *
 * A request that has not answered within `AUTH_PROVIDER_TIMEOUT_SECONDS` is `network` too, and is
 * aborted: without the bound, a stalled mobile network left "Signing in…" on the button until a
 * reload. The race is against our own timer as well as the abort, so a `fetch` that ignores its
 * signal still gives the button back.
 */
async function send(config: AuthConfig, request: ProviderRequest): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {
    apikey: config.publishableKey,
    Authorization: `Bearer ${request.bearer ?? config.publishableKey}`,
  };
  const controller = new AbortController();
  const init: RequestInit = { method: request.method, headers, signal: controller.signal };
  if (request.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(request.body);
  }
  if (request.keepalive === true) init.keepalive = true;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AuthError("network"));
    }, AUTH_PROVIDER_TIMEOUT_SECONDS * 1000);
  });
  try {
    let response: Response;
    try {
      response = await Promise.race([fetch(`${config.url}${request.path}`, init), timedOut]);
    } catch {
      throw new AuthError("network");
    }
    let json: unknown = null;
    try {
      json = await Promise.race([response.json() as Promise<unknown>, timedOut]);
    } catch {
      // A body that is not JSON (or never finished) is simply no detail; the status still classifies it.
    }
    return { status: response.status, json };
  } finally {
    clearTimeout(timer);
  }
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

type TokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_at?: unknown;
  expires_in?: unknown;
  user?: { email_confirmed_at?: unknown } | null;
};

/**
 * A token response as a `Session`, or null when it carries no access token. `Session.expiresAt`
 * is epoch ms on THIS DEVICE's clock, because every reader compares it with `Date.now()`: so it is
 * `now + expires_in`. GoTrue's `expires_at` (epoch seconds) is the provider's clock, and a device
 * whose clock ran an hour fast read every fresh session as expired; it is only the fallback when
 * `expires_in` is missing.
 */
function sessionFromTokens(body: TokenResponse, fallbackRefreshToken: string | null): Session | null {
  const accessToken = body.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) return null;
  const session: Session = { accessToken };
  session.refreshToken =
    typeof body.refresh_token === "string" && body.refresh_token.length > 0
      ? body.refresh_token
      : fallbackRefreshToken;
  if (typeof body.expires_in === "number" && Number.isFinite(body.expires_in) && body.expires_in > 0) {
    session.expiresAt = Date.now() + body.expires_in * 1000;
  } else if (typeof body.expires_at === "number" && Number.isFinite(body.expires_at)) {
    session.expiresAt = body.expires_at * 1000;
  } else {
    session.expiresAt = null;
  }
  return session;
}

// --- sign in, sign up --------------------------------------------------------------------------

export type SignInResult = { session: Session; emailVerified: boolean };

/**
 * GoTrue's password grant. On success the access token goes to `writeSession` (the caller's job)
 * and every later request carries it; `/api/auth/me` is what then reports the profile's status, so
 * this function deliberately learns nothing about `pending` vs `active`.
 */
export async function signIn(email: string, password: string): Promise<SignInResult> {
  const config = requireConfig();
  const { status, json } = await send(config, {
    method: "POST",
    path: "/auth/v1/token?grant_type=password",
    body: { email, password },
  });
  // Every account-dependent refusal collapses to one message (R160), `email_not_confirmed` included.
  if (!isSuccess(status)) throw new AuthError(classifyProviderRefusal("signIn", status, json));

  const body = (json ?? {}) as TokenResponse;
  const session = sessionFromTokens(body, null);
  if (session === null) throw new AuthError("credentials");

  // A sign-in ends whatever sign-up or reset this browser was waiting on (R193).
  forgetPendingAddresses();

  return {
    session,
    // §9.4 step 1 needs a verified email, but the SERVER decides that from the auth server
    // (`email_confirmed_at`), never from the token -- `user_metadata` is user-editable. This flag
    // is for this screen's wording only and nothing downstream trusts it.
    emailVerified:
      typeof body.user?.email_confirmed_at === "string" && body.user.email_confirmed_at.length > 0,
  };
}

export type SignUpResult = { needsEmailConfirmation: boolean };

/**
 * GoTrue's sign-up. This project's Supabase has `mailer_autoconfirm: false` (confirmations ON),
 * which SPEC §9.4 step 1 requires -- "reject unless the account is pending with a verified email".
 *
 * That setting is also what keeps this endpoint from being an enumeration oracle without any work
 * here: with confirmations on, GoTrue answers an ALREADY-REGISTERED address exactly as it answers a
 * new one, returning a user object with no session. So the screen says "check your email" either
 * way, which is R160's "identical for every outcome that depends on whether an account exists"
 * satisfied by the provider rather than by a message this module has to flatten.
 *
 * The address is remembered as this browser's pending sign-up, for the hints and the mail interval
 * that follow it. Its confirmation link signs nothing in (R193): an address someone registered
 * first keeps their password through this sign-up, and only a sign-in by hand shows it.
 */
export async function signUp(email: string, password: string): Promise<SignUpResult> {
  const config = requireConfig();
  const { status, json } = await send(config, {
    method: "POST",
    path: withRedirect("/auth/v1/signup"),
    body: { email, password, ...(await pkceFields("signup")) },
  });
  if (!isSuccess(status)) throw providerRefusal("signUp", status, json);

  rememberPendingEmail(email);
  // With confirmations on there is no session to return: the account exists but cannot sign in
  // until the link is clicked. The one case where a session WOULD come back is a project with
  // autoconfirm on, and this screen still sends the player to sign in, which then succeeds.
  return { needsEmailConfirmation: true };
}

// --- the two mailers ---------------------------------------------------------------------------

/**
 * The two mailers answer the same way whatever the provider said (R192), bar two answers that are
 * about the caller and not the address: the provider could not be reached at all (`network`), and
 * the typed address is not an address (`invalidEmail`).
 *
 * Everything else resolves, because the provider's other answers depend on whether the address has
 * an account. It answers an unknown address 200 without ever reaching its mailer, so only a KNOWN
 * address can come back 429 (its per-address interval), 500 (the mail could not be sent) or 400
 * `email_address_not_authorized` (the built-in mailer's allow-list). Reporting any of those would
 * make the forgot-password form an account-existence oracle.
 */
function mailerRefusal(endpoint: "resend" | "recover", status: number, json: unknown): AuthError | null {
  if (isSuccess(status)) return null;
  const failure = classifyProviderRefusal(endpoint, status, json);
  return failure === "invalidEmail" ? new AuthError(failure) : null;
}

/**
 * Mail the sign-up confirmation link again. Resolves on every provider answer but an invalid
 * address (`mailerRefusal`, R192): the screen answers the same neutral sentence either way and
 * waits out `AUTH_EMAIL_RESEND_COOLDOWN_SECONDS` before offering the button again.
 */
export async function resendConfirmation(email: string): Promise<void> {
  const config = requireConfig();
  const { status, json } = await send(config, {
    method: "POST",
    path: withRedirect("/auth/v1/resend"),
    // The sign-up's verifier again, so the first email's link still exchanges after this one.
    body: { type: "signup", email, ...(await pkceFields("signup", true)) },
  });
  const refusal = mailerRefusal("resend", status, json);
  if (refusal !== null) throw refusal;
  rememberPendingEmail(email);
}

/**
 * Mail a password-reset link. Resolves on every provider answer but an invalid address, like
 * `resendConfirmation` (OWASP's forgot-password rule, R192).
 *
 * The address is remembered as this browser's pending reset: a recovery link for it is held at
 * once, and any other one only after the player types the address it was sent to (R193), so a link
 * someone else requested for their own account cannot sign this browser into it.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const config = requireConfig();
  const { status, json } = await send(config, {
    method: "POST",
    path: withRedirect("/auth/v1/recover"),
    body: { email, ...(await pkceFields("recovery")) },
  });
  const refusal = mailerRefusal("recover", status, json);
  if (refusal !== null) throw refusal;
  rememberPendingReset(email);
}

// --- an emailed link's code (R323, R324) --------------------------------------------------------

/** GoTrue's answer when a verifier is not the one the code's challenge was made from. */
const BAD_CODE_VERIFIER = "bad_code_verifier";

/** A GoTrue auth code is a UUID; anything else in `?code=` is not one, and is never sent. */
const AUTH_CODE_PATTERN = /^[A-Za-z0-9-]{1,128}$/u;

export function isAuthCode(code: string): boolean {
  return AUTH_CODE_PATTERN.test(code);
}

export type CodeExchange =
  /** The code and a verifier here matched: the link's session, and which kind of link it was. */
  | { kind: "session"; session: Session; flow: PkceFlow }
  /**
   * No verifier here matches the code: the link was asked for on another device or browser, or this
   * browser's storage was cleared (R324). The provider confirmed the address before it sent the
   * player here with a code, so a confirmation link has done its work.
   */
  | { kind: "elsewhere" }
  /** The provider refused the code itself: spent, expired, or never real. */
  | { kind: "refused" };

/**
 * R323: an emailed link's `code` for a session, with the verifier this browser kept when it asked
 * for the link. The newest verifier is tried first; one the provider answers `bad_code_verifier`
 * belongs to another link, so the next is tried, and none left is `elsewhere` (R324). A refused
 * verifier leaves the code usable, so trying one does not spend it. A verifier is forgotten once
 * its code has been exchanged. Throws `network` or `service` when the provider could not answer;
 * the code is then still good for another try.
 */
export async function exchangeAuthCode(code: string): Promise<CodeExchange> {
  if (!isAuthCode(code)) return { kind: "refused" };
  const config = requireConfig();
  for (const { flow, verifier } of storedVerifiers()) {
    const { status, json } = await send(config, {
      method: "POST",
      path: "/auth/v1/token?grant_type=pkce",
      body: { auth_code: code, code_verifier: verifier },
    });
    if (isSuccess(status)) {
      const session = sessionFromTokens((json ?? {}) as TokenResponse, null);
      if (session === null) return { kind: "refused" };
      forgetVerifier(flow);
      return { kind: "session", session, flow };
    }
    if (status >= 500) throw new AuthError("service");
    if (status === 429) throw new AuthError("rateLimited");
    if (providerCode(json) === BAD_CODE_VERIFIER) continue;
    return { kind: "refused" };
  }
  return { kind: "elsewhere" };
}

// --- session calls -----------------------------------------------------------------------------

/** Set a new password with the recovery link's access token (`/reset-password`). */
export async function updatePassword(accessToken: string, password: string): Promise<void> {
  const config = requireConfig();
  const { status, json } = await send(config, {
    method: "PUT",
    path: "/auth/v1/user",
    body: { password },
    bearer: accessToken,
  });
  if (!isSuccess(status)) throw providerRefusal("updatePassword", status, json);
}

/**
 * In-flight renewals, keyed by the refresh token they spend. GoTrue ROTATES refresh tokens and
 * treats a reused one as stolen (revoking the whole session family), so two screens renewing at
 * once must share one request rather than race (R194). Cleared as soon as the request settles.
 */
const refreshesInFlight = new Map<string, Promise<Session>>();

async function renewOnce(refreshToken: string): Promise<Session> {
  const config = requireConfig();
  const { status, json } = await send(config, {
    method: "POST",
    path: "/auth/v1/token?grant_type=refresh_token",
    body: { refresh_token: refreshToken },
  });
  if (!isSuccess(status)) throw new AuthError(classifyProviderRefusal("refresh", status, json));
  const session = sessionFromTokens((json ?? {}) as TokenResponse, refreshToken);
  // A 2xx without a token is the provider misbehaving, not the session ending: keep it, try later.
  if (session === null) throw new AuthError("service");
  return session;
}

/**
 * GoTrue's refresh grant: a new session for a refresh token (R194). Concurrent calls with the same
 * refresh token share ONE request and get the same promise. A refusal is `sessionEnded` (sign in
 * again); `network` and `service` mean the session may still be good and should be kept.
 */
export function refreshSession(refreshToken: string): Promise<Session> {
  const existing = refreshesInFlight.get(refreshToken);
  if (existing !== undefined) return existing;
  const request = renewOnce(refreshToken).finally(() => {
    refreshesInFlight.delete(refreshToken);
  });
  refreshesInFlight.set(refreshToken, request);
  return request;
}

/**
 * Revoke this session's refresh token at the provider (R194), so a copied token cannot outlive a
 * sign-out. `keepalive` lets the request finish while the page unloads, because sign-out loads `/`
 * straight after firing it. Best effort: it ALWAYS resolves and never throws, since the device's
 * copy is already gone and a failure here has nothing left to tell the player.
 */
export async function revokeSession(accessToken: string): Promise<void> {
  try {
    const config = authConfig();
    if (config === null || accessToken.length === 0) return;
    await logout(config, accessToken);
  } catch {
    // Nothing to do: see above.
  }
}

async function logout(config: AuthConfig, accessToken: string): Promise<number> {
  const { status } = await send(config, {
    method: "POST",
    path: "/auth/v1/logout?scope=local",
    bearer: accessToken,
    keepalive: true,
  });
  return status;
}

/**
 * Makes `next` this browser's session, and revokes the one it replaces (R194) when that is a
 * different session: signing in as B over A, or a saved reset ("Saving signs
 * this browser out of A"). Dropping A's tokens from the device without revoking them left A's
 * refresh token live at the provider after the player had been told they were signed out of it.
 * Fired, never awaited (`revokeSignedOutSession` renews an expired A first so it can be revoked).
 */
export function adoptSession(next: Session): void {
  const previous = readSession();
  writeSession(next);
  if (previous !== null && previous.accessToken !== next.accessToken) void revokeSignedOutSession(previous);
}

/** R194: a session this close to expiring (or past it) is renewed before it is used. */
export function sessionNearExpiry(session: Session, now: number): boolean {
  const expiresAt = session.expiresAt;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return false;
  return expiresAt - now <= AUTH_SESSION_REFRESH_MARGIN_SECONDS * 1000;
}

/**
 * Sign-out's revocation (R194), for a session that may have outlived its access token.
 *
 * GoTrue's `/logout` authenticates with the access token, and refuses an expired one without
 * revoking anything, so a tab left open past the hour used to sign out on the device only and leave
 * the refresh token alive at the provider. So a session within `AUTH_SESSION_REFRESH_MARGIN_SECONDS`
 * of expiring (or past it) is renewed first and revoked with the new access token, and a revocation
 * the provider refuses as unauthorised is renewed and retried once. Renewing rotates the refresh
 * token, and the revocation then ends the session that token belongs to. Always resolves.
 */
export async function revokeSignedOutSession(session: Session): Promise<void> {
  try {
    const config = authConfig();
    if (config === null || session.accessToken.length === 0) return;
    const refreshToken =
      typeof session.refreshToken === "string" && session.refreshToken.length > 0 ? session.refreshToken : null;
    let accessToken = session.accessToken;
    let renewed = false;
    const renew = async (): Promise<boolean> => {
      if (refreshToken === null || renewed) return false;
      renewed = true;
      try {
        accessToken = (await refreshSession(refreshToken)).accessToken;
        return true;
      } catch {
        return false;
      }
    };

    if (sessionNearExpiry(session, Date.now())) await renew();
    const status = await logout(config, accessToken);
    if ((status === 401 || status === 403) && (await renew())) await logout(config, accessToken);
  } catch {
    // Nothing to do: the device's copy is already gone (see `revokeSession`).
  }
}
