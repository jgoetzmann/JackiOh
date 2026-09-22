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
// NO `@supabase/supabase-js`. Two POSTs against GoTrue's REST API need no SDK, and an SDK would
// actively fight this codebase: it persists its own session to `localStorage` under its own key,
// while `net/session.ts` owns that storage and its key is a contract with the M8 specs. One
// `fetch` each keeps the token flowing through `writeSession` exactly as before.
//
// GoTrue reference: POST /auth/v1/token?grant_type=password and POST /auth/v1/signup, both
// authenticated with the publishable key in the `apikey` header.

import type { Session } from "./session.ts";

/**
 * R160, the client half: "Sign-up and sign-in answer identically for every outcome that depends on
 * whether an account exists -- no such account, wrong password, already registered -- so neither
 * becomes an account-enumeration oracle... One error per endpoint, not one shared between them."
 *
 * So these are the ONLY two failure messages this module produces for a refusal, and the provider's
 * own wording is never relayed: GoTrue distinguishes `invalid_grant` from `email_not_confirmed`,
 * and the second of those is an existence oracle for any address an attacker cares to try. A
 * configuration fault is different in kind -- it depends on this deployment, not on any account --
 * and says so.
 *
 * The strings match `SIGN_IN_FAILED_MESSAGE` and `SIGN_UP_FAILED_MESSAGE` in
 * `apps/server/src/api/auth.ts`, so the disabled server path and this one refuse in the same words.
 */
export const SIGN_IN_FAILED_MESSAGE = "That email and password do not match an account.";
export const SIGN_UP_FAILED_MESSAGE = "Could not create that account.";

/** A refusal from the auth provider, already reduced to one of the two messages above. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

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

export const AUTH_UNCONFIGURED_MESSAGE =
  "This build has no auth provider configured: set VITE_SUPABASE_URL and " +
  "VITE_SUPABASE_PUBLISHABLE_KEY in apps/web/.env (see apps/web/.env.example).";

type TokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_at?: unknown;
  user?: { email_confirmed_at?: unknown } | null;
};

async function post(
  config: AuthConfig,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${config.url}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: config.publishableKey,
      Authorization: `Bearer ${config.publishableKey}`,
    },
    body: JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    // A body that is not JSON is simply no detail; the caller refuses either way.
  }
  return { status: response.status, json };
}

export type SignInResult = { session: Session; emailVerified: boolean };

/**
 * GoTrue's password grant. On success the access token goes to `writeSession` and every later
 * request carries it; `/api/auth/me` is what then reports the profile's status, so this function
 * deliberately learns nothing about `pending` vs `active`.
 */
export async function signIn(email: string, password: string): Promise<SignInResult> {
  const config = authConfig();
  if (config === null) throw new AuthError(AUTH_UNCONFIGURED_MESSAGE);

  const { status, json } = await post(config, "/auth/v1/token?grant_type=password", {
    email,
    password,
  });
  // Every refusal collapses to one message (R160), including `email_not_confirmed`.
  if (status < 200 || status >= 300) throw new AuthError(SIGN_IN_FAILED_MESSAGE);

  const body = (json ?? {}) as TokenResponse;
  const accessToken = body.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new AuthError(SIGN_IN_FAILED_MESSAGE);
  }

  const session: Session = { accessToken };
  session.refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : null;
  // GoTrue reports `expires_at` in SECONDS; `Session.expiresAt` is the epoch-ms the rest of the
  // client uses, so it is converted here rather than at each reader.
  session.expiresAt = typeof body.expires_at === "number" ? body.expires_at * 1000 : null;

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
 */
export async function signUp(email: string, password: string): Promise<SignUpResult> {
  const config = authConfig();
  if (config === null) throw new AuthError(AUTH_UNCONFIGURED_MESSAGE);

  // WHERE THE CONFIRMATION LINK POINTS. GoTrue builds it from the project's Site URL, which is
  // still its default (`http://localhost:3000`) — so every confirmation email sent from the
  // deployed site pointed at the reader's own machine and was useless. `redirect_to` overrides it
  // per sign-up, and taking the value from `window.location.origin` means the link comes back to
  // whichever deployment actually sent it: production, a Vercel preview, or a dev server.
  //
  // Supabase only honours a `redirect_to` that matches the Site URL or an entry in the project's
  // Redirect URLs allow-list, and falls back to the Site URL when it does not — so this fixes the
  // link the moment the deployed origin is allow-listed, and cannot be used to point a
  // confirmation email at an attacker's domain.
  const redirectTo = typeof window === "undefined" ? "" : `${window.location.origin}/login`;
  const path =
    redirectTo === ""
      ? "/auth/v1/signup"
      : `/auth/v1/signup?redirect_to=${encodeURIComponent(redirectTo)}`;

  const { status } = await post(config, path, { email, password });
  if (status < 200 || status >= 300) throw new AuthError(SIGN_UP_FAILED_MESSAGE);

  // With confirmations on there is no session to return: the account exists but cannot sign in
  // until the link is clicked. The one case where a session WOULD come back is a project with
  // autoconfirm on, and this screen still sends the player to sign in, which then succeeds.
  return { needsEmailConfirmation: true };
}
