# Polish 5: sign-in hardening and landing page

Design notes for `polish/5-sign-in` ([brief](reference.md), section "5."). Written 2026-09-22 against
`main` at `cd780db`. SPEC.md still holds every rule. Where this document and SPEC disagree, SPEC wins.

## Goal

Make getting into JackiOh safe and easy to follow, and make the first screen feel like a game rather
than a form. The invite code is read the same way on both sides by one shared function, which is
proved against one shared test table. The code is typed into a segmented field that upper-cases as
you type, moves on to the next group by itself, accepts a paste in any form, and says so when you
type one of the characters the alphabet leaves out (it never drops one silently). A rate limit says
how long to wait, and R145's identical code error stays byte for byte what it is. Sign-up and
sign-in get validation, provider errors turned into plain sentences, a confirmation resend, a
forgot-password and reset flow, session renewal, and a way out of every screen. Three server
weaknesses found while reading the code are closed:

- a spoofable `X-Forwarded-For` that got around both per-IP limits;
- the invite field dropping excluded characters, which turned a typo into a different code;
- a redemption race in the in-memory stores.

`Landing` moves out of `main.tsx` into `routes/landing.tsx`, with a warm tavern hero, a strong
wordmark, an animated card fan, four CTAs (Play vs AI, Play online, Build decks, Sign in or Account)
and a "how it plays" strip. The page works down to 360 px and uses no third-party assets or branding.
Task 5 is built by implement-then-verify, not fullsend, because it touches an auth boundary. An
adversarial panel follows the build; the findings below are what that panel starts from.

## Research

### What Hearthstone does, and what this design borrows

| Hearthstone ([main menu][hs-menu], [Thinking Inside the Box][hs-box], [GDC 2015 UI talk][hs-gdc], [Game UI Database][hs-uidb]) | Borrowed here | Not borrowed |
| --- | --- | --- |
| The menu is a physical object: a wooden box on a tavern table, lit warmly, in a skeuomorphic style rather than a flat one. | A warm palette of wood, brass and hearth light, all as CSS tokens on `.landing`. The hero is layered for depth: hearth glow, a wood-grain table plane, a vignette, drifting embers. CTAs sit in a brass-trimmed panel. | Any art, logo, font (Belwe) or sound of theirs. The word "Hearthstone" in UI copy. The door-opening load animation, which is heavy and not needed. |
| One dominant play button, with the modes grouped around it. | **Play vs AI** is the single large gold CTA. Play online and Build decks are secondary wood buttons under it. Sign in or Account sits in the top corner. | The quest log, shop and pack buttons: we have no economy. |
| "Our game is UI". Every element answers the player physically and aims to delight (Derek Sakamoto, GDC 2015). | CTAs press down (`translateY` and a collapsing shadow) and glow on hover. The card fan deals in, breathes, and spreads on hover. The radiant card shimmers. The title has an embossed gold treatment. | Particle-heavy canvas effects: task 1 owns `fx/`, and the landing stays CSS-only. |
| Cards held in a fanned hand. | Five decorative cards (`aria-hidden`), rotated about a point below the fan, with glyph gems instead of numerals. | Real card faces: task 6's `CardFace` can replace them at integration. |

### Prior art for the non-visual parts

- **Code entry is one input drawn as groups.** A single semantic input keeps paste, autofill, undo,
  deletion and screen readers working. Several linked inputs lose them
  ([input-otp][otp-lib], [Using a single input for one-time-code][otp-single],
  [HTML & CSS for a one-time password input][otp-fem]). This design uses one `<input>` with its
  text made transparent, over four visual segments. That is the `input-otp` pattern.
- **Look-alike characters.** [Crockford base32][crockford] makes codes typeable by *mapping*
  look-alikes (O→0, I and L→1). R104's alphabet leaves out both halves of each pair (0 and O, 1 and
  I), so nothing can be mapped. The only honest answers are to refuse the character or treat the
  code as malformed. Dropping it is never right, and that is what the client does today.
- **Client address behind proxies.** Take the entry your own proxy wrote, counted from the
  **right**. Everything to its left was written by the caller
  ([The perils of the "real" client IP][xff-adam], [MDN X-Forwarded-For][xff-mdn]). Render's
  behaviour is disputed: staff say the first entry is the client, and a customer reports that Render
  only appends to what the caller sent ([Render feedback][xff-render]). The rightmost trusted hop is
  safe under both readings.
- **Account enumeration.** The forgot-password page must answer the same for known and unknown
  addresses ([OWASP Forgot Password][owasp-fp]). Supabase's `/recover` and `/resend` already return
  200 for an unknown address. Our UI must not add a difference of its own.
- **Emailed links.** Supabase's `resend` takes a redirect ([docs][sb-resend]). Mail scanners
  prefetch links and use up one-time tokens, which shows up as `otp_expired`
  ([Supabase troubleshooting][sb-otp]). So the expired-link screen has to offer the way forward
  itself.

### What the code does today (the findings this design starts from)

| # | Where | Finding | Kind |
| --- | --- | --- | --- |
| F1 | `apps/server/src/api/http.ts` `clientAddress` | It trusts the **leftmost** `X-Forwarded-For` entry, then `cf-connecting-ip` and `x-real-ip`. A caller who changes that header on every request gets a new IP bucket each time, which gets around §9.4 step 3 (20 per IP per hour) and R157's anonymous API bucket. | security |
| F2 | `apps/web/src/routes/invite.tsx` `inviteCodeCharacters` | It drops 0/O/1/I and keeps going, so `ABCD-0FGH-…` becomes `ABCDFGH…`: a *different* code, sent silently. | correctness |
| F3 | same | `maxLength={19}` cuts off a paste of `" abcd - efgh - jkmn - pqrs "` before `onChange` sees it. | correctness |
| F4 | `apps/server/src/api/crypto.ts` `normalizeCode` | It strips only `[\s-]`. En dashes, zero-width spaces and fullwidth forms pasted from mail or chat are treated as malformed, so a person with a real code gets R145's error. | UX |
| F5 | `apps/server/src/api/e2e-store.ts` `createInMemoryRedeem` | Two concurrent redemptions by one profile both pass step 1 across an `await`, so one account uses up two codes. The in-memory `tx` depth counter also lets one concurrent transaction join another. (The adversarial panel found Postgres was not safe either: see "After the adversarial panel".) | race |
| F6 | `apps/server/src/api/codes.ts` | A 429 gives no hint of how long to wait. The code screen doesn't know how many attempts are left. | UX |
| F7 | `apps/server/src/api/http.ts` `readBody` | The body size is unbounded, and a huge `code` string is normalised before being refused. | robustness |
| F8 | `apps/web/src/net/auth.ts` | Every refusal, a 429 and a 5xx included, reads "That email and password do not match an account." A rate-limited or unconfirmed player is told their password is wrong. | UX |
| F9 | `apps/web/src/routes/login.tsx` | No forgot password, no resend, no validation. The confirmation link comes back to `/login#access_token=…`, and the tokens are ignored and left in the address bar and in history. | UX, token handling |
| F10 | `apps/web/src/net/gate.ts` | The refresh token is stored and never used, so an hour after sign-in every screen quietly sends the player back to `/login`. | UX |
| F11 | `apps/web/src/routes/account.tsx` `signOut` | It clears the device and leaves the refresh token valid at the provider. | token handling |
| F12 | `apps/web/src/main.tsx` | The gate's error panel, its banned panel and the 404 panel have no way out. | dead ends |
| F13 | implicit-flow links | Any `#access_token` on `/login` would be accepted. That lets an attacker sign a victim into the *attacker's* pending account, where the victim's own invite code would activate the attacker (login CSRF). | security |

## Surface

Every path below is under the repo root. "(new)" marks a file this task creates.

### Shared code reading: `packages/shared/src/codes.ts` (new), exported from `packages/shared/src/index.ts`

```ts
/** The shape of a code. The values live in apps/server/src/config.ts (CLAUDE.md rule 9). */
export type CodeFormat = {
  readonly alphabet: string;       // R104: "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
  readonly length: number;         // 16 for an invite code, 6 for a room code
  readonly groupSize: number;      // 4 for an invite code; equal to length for a room code
  readonly separator: string;      // "-"
  readonly maxInputLength: number; // CODE_INPUT_MAX_LENGTH: longer raw input is tooLong, unread
};

export type CodeInputProblem =
  /** An ASCII letter or digit outside the alphabet after upper-casing: R104's 0, 1, I, O. */
  | { readonly kind: "excluded"; readonly character: string }
  /** Any other character that is neither in the alphabet nor a separator. */
  | { readonly kind: "foreign"; readonly character: string }
  /** More than `length` alphabet characters, or raw input longer than `maxInputLength`. */
  | { readonly kind: "tooLong" };

export type CodeInputReading = {
  /** The alphabet characters accepted, in order, stopping at the first problem; at most `length`. */
  readonly characters: string;
  /** `characters` in groups of `groupSize` joined by `separator`, with no trailing separator. */
  readonly formatted: string;
  /** problem === null && characters.length === length */
  readonly complete: boolean;
  readonly problem: CodeInputProblem | null;
};

/** True for whitespace (\s, which includes NBSP and U+3000), U+002D, U+2010-U+2015, U+2212,
 *  U+FE58, U+FE63, U+FF0D, U+00AD, U+200B-U+200D, U+2060 and U+FEFF. Nothing else. */
export function isCodeSeparator(character: string): boolean;
/** NFKC, then each code point upper-cased on its own (one that upper-cases to more than one
 *  character, such as "ß", is kept as it was so it reads as foreign), then separators removed.
 *  Knows nothing of an alphabet. */
export function normalizeCodeText(raw: string): string;
/** Refuses raw.length > maxInputLength without reading it. Otherwise it walks normalizeCodeText(raw)
 *  and stops at the first excluded, foreign or tooLong character. Never drops or maps a character. */
export function readCodeInput(raw: string, format: CodeFormat): CodeInputReading;
/** readCodeInput(raw, format).complete ? characters : null */
export function canonicalCode(raw: string, format: CodeFormat): string | null;
export function formatCodeCharacters(characters: string, format: CodeFormat): string;
/** Caret index in `formatted` after `characterCount` characters:
 *  n + (n > 0 ? Math.floor((n - 1) / groupSize) : 0). */
export function formattedCaret(characterCount: number, format: CodeFormat): number;
/** If canonicalCode(text) is non-null, returns it. Otherwise it scans the normalised, upper-cased
 *  text as chains of words (ASCII letter and digit runs joined only by separators, in one case) and
 *  returns the canonical code only if exactly one distinct code is found. A chain that reads as one
 *  code is that code; a code inside a longer chain counts only when the words beside it are joined
 *  to it differently from how its own groups are joined (see "After the adversarial panel"). */
export function findCodeInText(text: string, format: CodeFormat): string | null;
/** ASCII [0-9A-Z] minus the alphabet, sorted: ["0", "1", "I", "O"] for R104. */
export function excludedCharacters(format: CodeFormat): readonly string[];
```

### The shared test table: `packages/shared/test/fixtures/code-input-cases.ts` (new, tester 1)

```ts
import type { CodeInputProblem } from "../../src/codes.ts";
export type CodeInputCase = {
  readonly name: string;
  readonly input: string;
  /** canonicalCode(input, INVITE_CODE_FORMAT). The server must redeem a code minted as this. */
  readonly canonical: string | null;
  /** readCodeInput(input, INVITE_CODE_FORMAT).formatted */
  readonly formatted: string;
  readonly problem: CodeInputProblem["kind"] | null;
  /** The character an excluded or foreign problem names. */
  readonly character?: string;
  /** findCodeInText(input, INVITE_CODE_FORMAT) !== null: the paste handler fills the field. */
  readonly foundInText: boolean;
};
export const CODE_INPUT_CASES: readonly CodeInputCase[];
```

The table has at least these rows:

- canonical form;
- lower case;
- no separators;
- spaces as separators;
- leading and trailing whitespace, tabs and newlines;
- en and em dashes;
- NBSP;
- a zero-width space inside a group;
- the fullwidth form;
- mixed ` - ` separators;
- a lowercase `l` (read as `L`);
- each of `0`, `1`, `O`, `I`, and a lowercase `o` (excluded);
- `#`, `İ` and `ß` (foreign);
- 15 characters (incomplete, no problem);
- 17 characters (tooLong);
- input longer than `maxInputLength` (tooLong);
- "Your invite: abcd-efgh-jkmn-pqrs." (foundInText);
- a text holding two different codes (not found).

Every canonical code is built from R104's alphabet, for example `ABCDEFGHJKMNPQRS`.

### Server constants: `apps/server/src/config.ts` (additions only)

```ts
export const CODE_INPUT_MAX_LENGTH = 64;               // R191: longer input is malformed, unread
export const INVITE_CODE_FORMAT = { alphabet: CODE_ALPHABET, length: INVITE_CODE_LENGTH,
  groupSize: INVITE_CODE_GROUP_SIZE, separator: INVITE_CODE_SEPARATOR,
  maxInputLength: CODE_INPUT_MAX_LENGTH } as const;    // plain literal; config.ts imports nothing
export const ROOM_CODE_FORMAT = { alphabet: CODE_ALPHABET, length: ROOM_CODE_LENGTH,
  groupSize: ROOM_CODE_LENGTH, separator: INVITE_CODE_SEPARATOR,
  maxInputLength: CODE_INPUT_MAX_LENGTH } as const;
export const DEFAULT_TRUSTED_PROXY_HOPS = 0;           // R190 (was 1; see "After the adversarial panel")
export const MAX_TRUSTED_PROXY_HOPS = 5;               // R190
export const API_MAX_BODY_BYTES = 65_536;
export const AUTH_PASSWORD_MIN_LENGTH = 6;             // mirrors Supabase Auth's default minimum
export const AUTH_PASSWORD_MAX_LENGTH = 72;            // the auth provider's bcrypt limit
export const AUTH_EMAIL_RESEND_COOLDOWN_SECONDS = 60;  // R192: the provider's per-address interval
export const AUTH_SESSION_REFRESH_MARGIN_SECONDS = 60; // R194
```

The web imports these the way `invite.tsx` already imports `CODE_ALPHABET`, by the relative path
`../../../server/src/config.ts`. They are public values. `config.ts` holds no secret and must stay
that way.

### Server HTTP surface

`apps/server/src/api/http.ts`:

```ts
export type RequestContext = { readonly peerAddress: string | null };
export const UNKNOWN_CLIENT_ADDRESS = "unknown";
/** R190: splits and trims every X-Forwarded-For value and drops empty entries. With hops >= 1 and at
 *  least `hops` entries it returns entries[length - hops]. Otherwise it returns peerAddress, or
 *  UNKNOWN_CLIENT_ADDRESS. It never reads cf-connecting-ip or x-real-ip. */
export function clientAddress(headers: Headers, peerAddress: string | null, trustedProxyHops: number): string;
/** code "rate_limited", status 429, details { retryAfterMs } */
export function rateLimited(message: string, retryAfterMs: number): ApiError;
/** As before. It adds `retry-after: <ceil(ms / 1000)>` when error.code === "rate_limited" and
 *  details.retryAfterMs is a finite number >= 0. No other error gains a header. */
export function errorResponse(error: ApiError): Response;
export type RateLimiter = {
  allow: (key: string, now: number) => boolean;
  /** 0 while the key has room; otherwise oldestCountedHit + windowMs - now. */
  retryAfterMs: (key: string, now: number) => number;
  readonly size: number;
};
export type Router = (request: Request, context?: RequestContext) => Promise<Response>;
// createRouter(routes, deps): Router. It keys the IP hash on
// clientAddress(headers, context?.peerAddress ?? null, deps.trustedProxyHops ?? DEFAULT_TRUSTED_PROXY_HOPS).
// The API limiter's 429 is rateLimited("too many requests; slow down", limiter.retryAfterMs(key, now)).
// Each request carrying fewer X-Forwarded-For entries than any before it makes one
// deps.log.info("api.forwarded_for", { fewestEntries: <count>, trustedProxyHops }) per router, and
// no address is ever logged (see "After the adversarial panel").
// readBody stops reading past API_MAX_BODY_BYTES and throws badRequest("the request body is too large").
```

`apps/server/src/api/cors.ts`: `withCors<C>(handler: (request: Request, context?: C) => Promise<Response>, options: CorsOptions): (request: Request, context?: C) => Promise<Response>`. It passes `context` through unchanged.

`apps/server/src/api/ports.ts`: `ServerDeps.trustedProxyHops?: number`. When it is absent, the router uses `DEFAULT_TRUSTED_PROXY_HOPS`.

`apps/server/src/env.ts`: `ServerEnv.TRUSTED_PROXY_HOPS: number`. It is optional in the environment: an integer from 0 to `MAX_TRUSTED_PROXY_HOPS`, defaulting to `DEFAULT_TRUSTED_PROXY_HOPS`, where 0 means "ignore the header, use the peer". Any other value is one more entry in `loadEnv`'s problem list. It is added to `SERVER_ONLY_ENV_VARS`. `env.ts` imports the two constants from `./config`, which itself imports nothing.

`apps/server/src/index.ts`:

```ts
serve({ fetch: (request, env) => handler(request, { peerAddress: env?.incoming?.socket?.remoteAddress ?? null }), port })
```

It sets `deps.trustedProxyHops = env.TRUSTED_PROXY_HOPS`.

`apps/server/src/api/crypto.ts`:

- `normalizeCode(input)` becomes `normalizeCodeText(input)`. `hashes.code` and `rooms.ts` pick this up unchanged.
- A new `canonicalInviteCode(raw: string): string | null`, which is `canonicalCode(raw, INVITE_CODE_FORMAT)`.

`apps/server/src/api/codes.ts`:

- Redemption hashes `canonicalCode(plainCode, INVITE_CODE_FORMAT)`, and passes `codeHash: null` when that is null (malformed).
- Steps 2 and 3 answer `rateLimited(RATE_LIMITED_MESSAGE, deps.limits.redeemWindowMs)`.
- Every outcome is still padded (R107).
- `invalid_code` is unchanged: `{"error":{"code":"invalid_code","message":REDEMPTION_IDENTICAL_ERROR}}`, with no `details` and no `Retry-After`.

`GET /api/codes/status` now answers:

```ts
{ redemptionEnabled: boolean; retryAfterMs: number; attemptsRemaining: number; attemptsRetryAfterMs: number }
// attemptsRemaining = Math.max(0, limits.redeemPerProfilePerHour + 1
//   - await store.codes.countAttemptsByProfile(profile.id, now - limits.redeemWindowMs))
```

The `+ 1` is config.ts's reading of §9.4's strict "more than 5": attempt 7 is the first refused.

`apps/server/src/api/e2e-store.ts`: `createInMemoryRedeem` runs its calls one at a time through a promise chain. That is stricter than Postgres, which serialises redemptions only per profile, per IP hash (migration 0006) and per code. The signature doesn't change.

### Auth provider calls: `apps/web/src/net/auth.ts`

These all go to GoTrue's REST API with `apikey` set to the publishable key. The anonymous calls send `Authorization: Bearer <publishable>`. The session calls send `Authorization: Bearer <access token>`. The redirect is always `redirect_to=<window.location.origin>/login`, never read from input.

| Function | Request | Resolves |
| --- | --- | --- |
| `signIn(email, password): Promise<SignInResult>` (as today) | `POST /auth/v1/token?grant_type=password` | session |
| `signUp(email, password): Promise<SignUpResult>` (as today) | `POST /auth/v1/signup?redirect_to=…` | `{ needsEmailConfirmation: true }` |
| `resendConfirmation(email: string): Promise<void>` | `POST /auth/v1/resend?redirect_to=…` body `{ type: "signup", email }` | on 2xx **and on 429** (R192) |
| `requestPasswordReset(email: string): Promise<void>` | `POST /auth/v1/recover?redirect_to=…` body `{ email }` | on 2xx **and on 429** (R192) |
| `updatePassword(accessToken: string, password: string): Promise<void>` | `PUT /auth/v1/user` body `{ password }` | on 2xx |
| `refreshSession(refreshToken: string): Promise<Session>` | `POST /auth/v1/token?grant_type=refresh_token` body `{ refresh_token }` | a new session. Concurrent calls with the same refresh token share one request (module-level `Map<string, Promise<Session>>`, cleared when it settles) |
| `revokeSession(accessToken: string): Promise<void>` | `POST /auth/v1/logout?scope=local`, `keepalive: true` | always resolves, never throws |
| `authRedirectUrl(): string` | — | `${origin}/login`, or `""` when there is no window |

```ts
export type AuthEndpoint = "signIn" | "signUp" | "resend" | "recover" | "updatePassword" | "refresh";
export type AuthFailure =
  | "credentials" | "signUpRefused" | "rateLimited" | "emailRateLimited" | "weakPassword"
  | "samePassword" | "invalidEmail" | "signupsClosed" | "linkExpired" | "sessionEnded"
  | "network" | "service" | "unconfigured";
export class AuthError extends Error { readonly failure: AuthFailure; constructor(failure: AuthFailure); } // message = AUTH_MESSAGES[failure]
export const AUTH_MESSAGES: Readonly<Record<AuthFailure, string>>;
export const AUTH_NOTICES: Readonly<{ signUpSent: string; resendSent: string; resetSent: string;
  emailConfirmed: string; sessionExpired: string }>;
/** The error code is body.error_code, else body.code when it is a string, else body.error. Provider
 *  text (msg, error_description, message) is never read into a message. */
export function classifyProviderRefusal(endpoint: AuthEndpoint, status: number, body: unknown): AuthFailure;
// Kept verbatim, so R160 and the existing tests stand:
export const SIGN_IN_FAILED_MESSAGE = "That email and password do not match an account."; // AUTH_MESSAGES.credentials
export const SIGN_UP_FAILED_MESSAGE = "Could not create that account.";                     // AUTH_MESSAGES.signUpRefused
export const AUTH_UNCONFIGURED_MESSAGE; // AUTH_MESSAGES.unconfigured, unchanged
```

Every provider answer maps to an `AuthFailure` (a dash means the answer can't happen on that endpoint):

| Provider answer | signIn | signUp | resend, recover | updatePassword | refresh |
| --- | --- | --- | --- | --- | --- |
| `fetch` rejects | network | network | network | network | network (session kept) |
| 429, `over_email_send_rate_limit` | rateLimited | emailRateLimited | resolves (neutral) | rateLimited | rateLimited |
| 429, anything else | rateLimited | rateLimited | resolves (neutral) | rateLimited | rateLimited |
| status 500 or higher | service | service | resolves (neutral) | service | service (session kept) |
| `weak_password` | credentials | weakPassword, or the reason's own failure | — | weakPassword, or the reason's own failure | — |
| `same_password` | credentials | signUpRefused | — | samePassword | — |
| `email_address_invalid` | credentials | invalidEmail | invalidEmail | — | — |
| `signup_disabled`, `email_provider_disabled` | credentials | signupsClosed | resolves (neutral) | — | — |
| 401 or 403, or `bad_jwt`, `session_expired`, `session_not_found`, `refresh_token_not_found`, `refresh_token_already_used`, `invalid_grant` | credentials | signUpRefused | resolves (neutral) | linkExpired | sessionEnded |
| any other 4xx (including `email_not_confirmed`, `invalid_credentials`) | credentials | signUpRefused | resolves (neutral) | service | sessionEnded |

The messages are these. The builder may reword them but must keep the meaning. Testers import the constants and never retype the strings.

- `rateLimited`: "Too many attempts from this network. Wait a few minutes, then try again."
- `emailRateLimited`: "We couldn't send an email just now. Wait a few minutes, then try again."
- `weakPassword`: "That password is too weak. Choose a longer one that is harder to guess." (After the panel: no number, and one sentence per `weak_password.reasons` entry.)
- `samePassword`: "Choose a password different from your current one."
- `invalidEmail`: "Enter a valid email address."
- `signupsClosed`: "New accounts can't be created right now."
- `linkExpired`: "That link has expired or was already used. Request a new one below."
- `sessionEnded`: "Your session has ended. Sign in again."
- `network`: "Couldn't reach the sign-in service. Check your connection and try again."
- `service`: "The sign-in service had a problem. Try again in a minute."

The notices:

- `signUpSent`: "Check your email for a confirmation link, then sign in."
- `resendSent`: "If that address has an account waiting for confirmation, a new link is on its way."
- `resetSent`: "If that address has an account, a password reset link is on its way."
- `emailConfirmed`: "Your email is confirmed. Sign in to continue."
- `sessionExpired`: "Your session ended. Sign in again to continue."

### Session, gate, navigation

`apps/web/src/net/session.ts` (additions):

```ts
export const PENDING_EMAIL_STORAGE_KEY = "jackioh.auth.pendingEmail"; // localStorage, every access in try/catch
export function rememberPendingEmail(email: string): void; // set on signUp and resendConfirmation
export function pendingEmail(): string | null;
export function forgetPendingEmail(): void;                // on a consumed confirmation link, and on sign-in
```

`apps/web/src/net/gate.ts`:

```ts
export type Account =
  | { kind: "loading" }
  | { kind: "anonymous"; reason?: "expired" }             // "expired": a refresh the provider refused
  | { kind: "error"; message: string; retry?: () => void } // retry re-runs the read without a reload
  | { kind: "ready"; token: string; me: MeResponse };
export function useAccount(): Account; // same signature
```

`useAccount` renews once (R194) in two cases:

- the stored session has a `refreshToken` and `expiresAt - Date.now() <= AUTH_SESSION_REFRESH_MARGIN_SECONDS * 1000`;
- `getMe` answers 401 and the session has a `refreshToken`.

After renewing, it writes the new session and retries `getMe` once.

- If the provider refuses the refresh (`sessionEnded`), `useAccount` calls `clearSession()` and returns `anonymous` with reason `"expired"`.
- If the refresh fails with `network` or `service`, it returns `error` and keeps the session.

`apps/web/src/net/navigate.ts`:

```ts
paths.resetPassword = "/reset-password";
paths.practice = "/practice"; // the identical line task 3 adds; the merge collapses them
export type LoginReason = "expired";
export type LoginEntryMode = "forgot";
/** "/login", "/login?reason=expired" or "/login?mode=forgot". Nothing else is ever put in the query. */
export function loginPath(options?: { reason?: LoginReason; mode?: LoginEntryMode }): string;
export function loginReasonOf(search: string): LoginReason | null;  // exactly "expired", else null
export function loginModeOf(search: string): LoginEntryMode | null; // exactly "forgot", else null
```

`navigate(loginPath(...))` pushes the query along with the path. `currentPath()` still compares
pathnames only.

### Emailed links: `apps/web/src/auth/redirect.ts` (new)

```ts
export type AuthRedirect =
  | { kind: "none" }
  /** type is signup | invite | magiclink | email_change */
  | { kind: "session"; session: Session; email: string | null }
  | { kind: "recovery"; session: Session; email: string | null }
  | { kind: "error"; failure: "linkExpired" | "linkDenied" };
/** Pure. It reads the fragment and then the query.
 *  - access_token, refresh_token, expires_at (seconds; ms = expires_at * 1000, or
 *    now + expires_in * 1000) and type build a session.
 *  - The email comes from the access token's payload, base64url-decoded and never verified.
 *  - error_code=otp_expired gives linkExpired. Any other error or error_code gives linkDenied.
 *  - error_description is never read.
 *  - An unknown type, or tokens without a type, gives none. */
export function parseAuthRedirect(url: URL): AuthRedirect;
/** Parses window.location. If any recognised auth parameter is present, it calls
 *  history.replaceState(null, "", pathname), which drops the query and the hash (R193), before
 *  returning. The result is cached, so a second call (StrictMode) returns the same value until
 *  clearConsumedAuthRedirect(). */
export function consumeAuthRedirect(): AuthRedirect;
export function clearConsumedAuthRedirect(): void;
export function holdRecoverySession(session: Session, email: string | null): void; // this tab only: memory, mirrored to sessionStorage
export function recoverySession(): { session: Session; email: string | null } | null;
export function releaseRecoverySession(): void;
```

The recognised auth parameters are `access_token`, `refresh_token`, `expires_at`, `expires_in`,
`token_type`, `type`, `error`, `error_code` and `error_description`.

### Validation: `apps/web/src/auth/validation.ts` (new)

```ts
export function normalizeEmail(raw: string): string;          // trim only
export function emailProblem(raw: string): string | null;     // /^[^\s@]+@[^\s@]+\.[^\s@]+$/ on the trimmed value
export function newPasswordProblem(password: string): string | null; // < AUTH_PASSWORD_MIN_LENGTH or > AUTH_PASSWORD_MAX_LENGTH characters
export function confirmProblem(password: string, confirm: string): string | null;
export function requiredProblem(value: string, label: string): string | null; // sign-in: non-empty only
```

### Code entry: `apps/web/src/auth/codeInput.ts`, `apps/web/src/auth/CodeField.tsx`, `apps/web/src/auth/code-field.css` (all new)

```ts
// codeInput.ts
export { INVITE_CODE_FORMAT } from "../../../server/src/config.ts";
export const INVITE_CODE_GROUPS: number;      // length / groupSize
export const INVITE_CODE_PLACEHOLDER: string; // "XXXX-XXXX-XXXX-XXXX", built from the format
export function codeProblemMessage(problem: CodeInputProblem, format?: CodeFormat): string;
//   excluded: `Invite codes never use 0, 1, I or O, so “${c}” can’t be part of one. Check that character again.`
//             (the list is built from excludedCharacters)
//   foreign:  `“${c}” isn’t used in invite codes. They use the letters A–Z except I and O, and the digits 2–9.`
//             (the ranges and the exceptions come from the alphabet; an invisible character shows as
//             U+XXXX; a letter outside ASCII adds "Check that your keyboard is set to Latin letters.")
//   tooLong:  `That’s longer than an invite code, which has ${length} characters.`
export function codeProgressText(reading: CodeInputReading, format?: CodeFormat): string; // "12 of 16 characters"
export function attemptsText(remaining: number): string; // "1 try left this hour" / "3 tries left this hour" / "No tries left for now. Try again later."

// CodeField.tsx
export type CodeFieldProps = {
  id: string;                  // the <input> id, for <label htmlFor>
  value: string;               // formatted, controlled
  onChange: (next: { formatted: string; complete: boolean }) => void;
  format?: CodeFormat;         // default INVITE_CODE_FORMAT
  testId?: string;             // default inviteTestid.input ("invite-code-input")
  disabled?: boolean;
  describedBy?: string;        // extra aria-describedby ids
};
export default function CodeField(props: CodeFieldProps): ReactElement;
```

The DOM contract:

- The root is `div.code-field[data-testid="code-field"]`. It carries `data-complete="true|false"`, and `data-problem="excluded|foreign|tooLong"` when there is a problem.
- Inside it is **one** `<input data-testid={testId}>` with these attributes:
  - `type="text"`, `inputMode="text"`, `autoComplete="off"`, `autoCapitalize="characters"`, `autoCorrect="off"`, `spellCheck={false}`;
  - `placeholder={INVITE_CODE_PLACEHOLDER}`;
  - `aria-invalid` and `aria-describedby`.
- The input has **no `maxLength`**. Its text may be `color: transparent`, but never `opacity: 0`, `visibility: hidden` or zero size, because Cypress must still see it.
- `INVITE_CODE_GROUPS` segments, `span[data-testid="code-field-segment-<i>"][aria-hidden="true"]`, each with `data-state="empty|partial|complete"` and `data-active="true|false"`.
- `p[data-testid="code-field-progress"][aria-live="polite"]`.
- `p[data-testid="code-field-hint"][role="status"][data-kind=<problem kind>]`, shown only while a problem stands.

The component behaves as follows:

- **`onChange(raw)`:**
  - With a problem, the value stays as it was and the hint shows.
  - Otherwise the value becomes `formatted`. The caret goes to `formattedCaret(<alphabet characters before the raw caret>)`, and the hint clears.
- **`onPaste`:** if `findCodeInText(clipboard)` returns a code, the handler calls `preventDefault` and sets that code's formatted value. Otherwise the paste goes through to `onChange`.
- **Backspace** with a collapsed caret right after a separator deletes the alphabet character before the separator. **Delete** right before one deletes the character after it, and the arrow keys cross a separator and the character beyond it.

### Invite screen: `apps/web/src/routes/invite.tsx`

It keeps these exports:

- `INVITE_CODE_INPUT`, `INVITE_SUBMIT`, `INVITE_ERROR`, `INVITE_PAUSED`, `INVITE_NOT_NEEDED` (values from `inviteTestid`);
- `INVITE_CODE_GROUPS` and `INVITE_CODE_PLACEHOLDER` (re-exported);
- `formatInviteCode(raw)`, which is now `readCodeInput(raw, INVITE_CODE_FORMAT).formatted`;
- the default `InviteRoute`.

It **removes** `inviteCodeCharacters`, because silently dropping characters is the bug F2.

`apps/web/src/net/api.ts`:

```ts
export type CodeStatusResponse = { redemptionEnabled: boolean; retryAfterMs: number; attemptsRemaining?: number };
/** details.retryAfterMs of an ApiRequestError whose code is "rate_limited", else null. */
export function retryAfterMsOf(error: unknown): number | null;
```

### Test ids: `apps/web/src/auth/testids.ts` (new, plain TS so Cypress `.ts` specs can import it)

```ts
export const landingTestid = { root: "landing", signIn: "landing-sign-in", account: "landing-account",
  playAi: "landing-play-ai", playOnline: "landing-play-online", buildDecks: "landing-build-decks",
  fan: "landing-card-fan", howItPlays: "landing-how-it-plays", hotseat: "landing-hotseat" } as const;
export function landingFanCardTestid(index: number): string; // `landing-fan-card-${index}`, 0..4
export function landingStepTestid(index: number): string;    // `landing-step-${index}`, 0..3
export const loginTestid = { form: "login-form", email: "login-email", password: "login-password",
  submit: "login-submit", togglePassword: "login-toggle-password", error: "login-error",
  mode: "login-mode", notice: "login-notice", emailError: "login-email-error",
  passwordError: "login-password-error", forgot: "login-forgot", backToSignIn: "login-back-to-sign-in",
  resend: "login-resend", resendCooldown: "login-resend-cooldown", linkError: "login-link-error",
  confirmed: "login-confirmed", sessionExpired: "login-session-expired" } as const;
export const resetTestid = { screen: "reset-screen", form: "reset-form", email: "reset-email",
  password: "reset-password", confirm: "reset-confirm", togglePassword: "reset-toggle-password",
  submit: "reset-submit", error: "reset-error", passwordError: "reset-password-error",
  confirmError: "reset-confirm-error", noLink: "reset-no-link", requestNew: "reset-request-new",
  backToSignIn: "reset-back-to-sign-in" } as const;
export const inviteTestid = { input: "invite-code-input", submit: "invite-submit", error: "invite-error",
  paused: "invite-paused", notNeeded: "invite-not-needed", attempts: "invite-attempts",
  rateLimited: "invite-rate-limited", accountEmail: "invite-account-email",
  signOut: "invite-sign-out", help: "invite-help" } as const;
export const codeFieldTestid = { root: "code-field", progress: "code-field-progress", hint: "code-field-hint" } as const;
export function codeFieldSegmentTestid(index: number): string; // `code-field-segment-${index}`
export const shellTestid = { loading: "gate-loading", error: "gate-error", retry: "gate-retry",
  home: "gate-home", signOut: "gate-sign-out", notFound: "not-found", notFoundHome: "not-found-home" } as const;
```

The data attributes:

- `login-form[data-mode="signIn|signUp|forgot"]`
- `login-resend-cooldown[data-seconds]`
- `invite-attempts[data-remaining]`
- `invite-rate-limited[data-retry-after-ms]`
- `invite-paused[data-retry-after-ms]` (as today)
- `landing[data-motion="full|reduced"]`, from `matchMedia("(prefers-reduced-motion: reduce)")`
- `landing[data-account="loading|anonymous|signed-in"]`

`login.tsx` re-exports `loginTestid` and `main.tsx` re-exports `shellTestid`, so every existing import keeps working. The existing ids `nav-back`, `account-*`, `login-*` and `landing-sign-in`/`landing-account` are unchanged (`99-online-smoke.cy.ts` reads them).

### Screens

- **`apps/web/src/routes/login.tsx`**, default `LoginRoute`, modes `"signIn" | "signUp" | "forgot"`.
  - On mount: `consumeAuthRedirect()`. It also reads `loginReasonOf` and `loginModeOf` from `location.search`, before the scrub. `mode=forgot` opens the forgot form, and `reason=expired` shows `login-session-expired`.
  - A `session` redirect writes nothing, fills in nothing (see "After the second panel round"), revokes the link's session and shows `login-confirmed` (`AUTH_NOTICES.emailConfirmed`), whatever address it names: the player signs in with their password (see "After the third panel round"). If its checked address equals `pendingEmail()` (compared case-insensitively), that sign-up's "confirm first" hint is over, so it calls `forgetPendingEmail`.
  - A `recovery` redirect: `holdRecoverySession`, then `navigate(paths.resetPassword, { replace: true })`.
  - An `error` redirect: `login-link-error` with `AUTH_MESSAGES.linkExpired`. Both `linkExpired` and `linkDenied` show that sentence. The resend and forgot actions show beside it.
  - The screen shows `BackLink` (`nav-back`) in every mode.
- **`apps/web/src/routes/reset-password.tsx`** (new), default `ResetPasswordRoute`. With `recoverySession()`, it shows:
  - the address (`reset-email`);
  - the new password and `reset-confirm`, each with show and hide;
  - submit.
  - On success: `updatePassword`, `writeSession`, `releaseRecoverySession`, `navigate(paths.decks)`.
  - Without a recovery session: `reset-no-link` with `reset-request-new`, which calls `navigate(loginPath({ mode: "forgot" }))`, and `reset-back-to-sign-in`, which goes to `/login`.
- **`apps/web/src/routes/account.tsx`**: `signOut(): void` keeps its signature. It reads the session, calls `clearSession()`, fires `void revokeSession(accessToken)` without awaiting it, then calls `window.location.assign(paths.landing)`.
- **`apps/web/src/routes/landing.tsx`** (new), default `LandingRoute(): ReactElement`, with `apps/web/src/routes/landing.css` (new). Every token and rule is scoped under `.landing`; nothing is added to `:root` or `index.css`.
  - The CTAs are `<a href>` with an `onClick` that calls `navigate` for a plain left click, so middle-click still works.
  - The numbers come from `@jackioh/engine/config` (`MAX_MANA`, `UNIT_ZONES`, `DECK_SIZE`) and `@jackioh/validator` (`LOADOUT_DECKS`).
  - Tokens:
    - `--tavern-night: #120b07`
    - `--tavern-wood-deep: #2b170c`
    - `--tavern-wood: #5a341b`
    - `--tavern-wood-light: #8a5a33`
    - `--tavern-brass: #c9953f`
    - `--tavern-gold: #f3c969`
    - `--tavern-gold-pale: #fbe7b0`
    - `--tavern-ember: #ff7a2f`
    - `--tavern-flame: #ffb347`
    - `--tavern-parchment: #efe0bf`
    - `--tavern-ink: #24160c`
    - `--tavern-teal: #3fb6a8`
  - The wordmark is `JackiOh` in a serif display stack (`"Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif`), filled with a gold gradient through `background-clip: text`, with a dark stroke, a warm glow and an under-shadow. No web font is loaded.
  - The fan has five cards rotated from -22 to 22 degrees about a point below them, with a deal-in, an idle float and a hover spread (`@media (hover: hover)`). The middle card is radiant with a shimmer, and one card is a face-down back with a rune.
  - Embers are at most 12 spans.
  - Every animation stops under `[data-motion="reduced"]` or the reduced-motion media query.
- **`apps/web/src/main.tsx`**:
  - It imports `LandingRoute` statically and lazy-loads `ResetPasswordRoute` for `paths.resetPassword`, which is not gated.
  - `redirectFor({ kind: "anonymous", reason: "expired" }, …)` returns `loginPath({ reason: "expired" })`, and plain `anonymous` still returns `"/login"`.
  - The gate's error panel gains `gate-retry` (which calls `account.retry?.()`), `gate-home` and `gate-sign-out`. The banned panel gains `gate-home` and `gate-sign-out`.
  - `NotFound` renders `not-found` and `not-found-home`, and says "That page doesn't exist." in a player's words, with the path shown beneath (never followed).

No `GameEvent`, no engine or view change, no settings module, and no new runtime dependency.

## Behaviors

1. **B1** `canonicalCode(row.input, INVITE_CODE_FORMAT)` equals `row.canonical` for every row of `CODE_INPUT_CASES`: case, spaces, ASCII and Unicode dashes, NBSP, zero-width characters, fullwidth forms and surrounding whitespace all read as the same code.
2. **B2** `readCodeInput` stops at the first character outside the alphabet and reports it. After upper-casing, `0`, `1`, `I` and `O` (so `o` and `i` too) are `excluded`, `l` is read as `L`, and anything else is `foreign`. No character is ever dropped or mapped (the table's `problem`, `character` and `formatted` columns).
3. **B3** Raw input longer than `CODE_INPUT_MAX_LENGTH` reads as `tooLong` without being normalised, and a 17th alphabet character reads as `tooLong`.
4. **B4** `findCodeInText` returns the canonical code for a paste holding exactly one grouped code ("Your invite: abcd-efgh-jkmn-pqrs."), and null for a text holding none or two different ones.
5. **B5** For every table row, `POST /api/codes/redeem` with `row.input` answers 200 when `row.canonical` is non-null (against a code minted as that canonical), and R145's byte-identical `invalid_code` body when it is null.
6. **B6** A `code` longer than `CODE_INPUT_MAX_LENGTH` gets the identical error, logs one attempt with reason `malformed`, and is padded to the redemption floor like every other outcome.
7. **B7** `GET /api/codes/status` returns `attemptsRemaining = max(0, redeemPerProfilePerHour + 1 − this profile's attempts in the window)`. Another profile's attempts from the same IP hash don't change it.
8. **B8** A redemption refused at §9.4 step 2 or 3 answers 429 `rate_limited` with `details.retryAfterMs === limits.redeemWindowMs` and a `Retry-After` header in whole seconds. Every code-dependent refusal still answers exactly `{"error":{"code":"invalid_code","message":REDEMPTION_IDENTICAL_ERROR}}`, with no `Retry-After`.
9. **B9** The API-wide limiter's 429 (R109) carries `details.retryAfterMs`, equal to the time until the oldest counted request leaves the window, and a matching `Retry-After`.
10. **B10** With one trusted hop, the IP hash comes from the rightmost `X-Forwarded-For` entry. Requests whose leftmost entries differ but whose rightmost entries match share one per-IP bucket, seen in `code_attempts.ipHash` and in the anonymous limiter (R157).
11. **B11** `CF-Connecting-IP` and `X-Real-IP` are never read. A request with fewer forwarded entries than the trusted hop count, none included, is keyed on `RequestContext.peerAddress`, or on `UNKNOWN_CLIENT_ADDRESS` when there is no peer address.
12. **B12** `loadEnv` accepts `TRUSTED_PROXY_HOPS` from 0 to `MAX_TRUSTED_PROXY_HOPS` (default `DEFAULT_TRUSTED_PROXY_HOPS`; 0 ignores the header) and lists any other value as a problem. The router logs `api.forwarded_for` each time a request carries fewer entries than any before it, with that count and never an address.
13. **B13** A request body larger than `API_MAX_BODY_BYTES` is refused with 400 `bad_request` before JSON parsing.
14. **B14** Two concurrent redemptions by one pending profile with two good codes activate it once and use up exactly one code. Two profiles racing for a code's last use get exactly one `ok`. Both hold in the in-memory store and in Postgres.
15. **B15** The code field is one `<input data-testid="invite-code-input">` with no `maxLength`, drawn as four `code-field-segment-<i>` whose `data-state` goes `empty` to `partial` to `complete` as groups fill, with `code-field-progress` reading "N of 16 characters".
16. **B16** Typing `abcdefgh` shows `ABCD-EFGH`, with the separator inserted automatically after the first group and the caret at the end.
17. **B17** Pasting any valid row's `input`, or a row with `foundInText`, fills the field with that row's formatted code. A paste with padding is never cut short.
18. **B18** Typing or pasting 0, 1, O or I leaves the value unchanged and shows `code-field-hint` with `data-kind="excluded"`, naming the character and the four excluded characters. The next accepted keystroke clears it.
19. **B19** Backspace with the caret right after a separator deletes the character before it, so holding Backspace always empties the field.
20. **B20** `invite-submit` is enabled only while the field is complete, redemption is not paused, no request is in flight and `attemptsRemaining` is not 0. It sends exactly the formatted code. A redemption refused with a 503 `unavailable` counts as paused at once, until the status says otherwise.
21. **B21** `invite-attempts` shows the tries left from `/api/codes/status` (`data-remaining`), and the status is read again after every refused redemption.
22. **B22** A 429 `rate_limited` refusal shows the server's sentence verbatim in `invite-error` and an `invite-rate-limited` panel with `data-retry-after-ms`, and disables submit. It never shows `REDEMPTION_IDENTICAL_ERROR`.
23. **B23** The invite screen always offers a way out: `nav-back`, `invite-account-email` and `invite-sign-out`. Sign out clears both session keys and lands on `/`.
24. **B24** Sign-up won't submit an email that fails `emailProblem`, or a password outside `AUTH_PASSWORD_MIN_LENGTH`..`AUTH_PASSWORD_MAX_LENGTH`. The field is marked `aria-invalid` with `login-email-error` or `login-password-error`. Sign-in only requires both fields to be non-empty, and the email is trimmed before it is sent.
25. **B25** Every provider refusal becomes the `AUTH_MESSAGES` entry `classifyProviderRefusal` names. Wrong password, unknown account and unconfirmed email all read `SIGN_IN_FAILED_MESSAGE` (R160). A provider `msg`, `error_description` or `error` string never appears in the DOM.
26. **B26** A 429 at sign-in or sign-up reads `rateLimited` or `emailRateLimited`, never `SIGN_IN_FAILED_MESSAGE` or `SIGN_UP_FAILED_MESSAGE` (R192).
27. **B27** `login-resend`, offered after a sign-up and after a failed sign-in, posts `/auth/v1/resend` with `type: "signup"` and `redirect_to=<origin>/login`. It shows `AUTH_NOTICES.resendSent` on a 2xx or a 429, then counts down `AUTH_EMAIL_RESEND_COOLDOWN_SECONDS` in `login-resend-cooldown` before it can be pressed again.
28. **B28** `login-forgot` switches to a one-field form. It posts `/auth/v1/recover` with `redirect_to=<origin>/login` and shows `AUTH_NOTICES.resetSent` whether or not the address has an account (on a 2xx or a 429), then offers `login-back-to-sign-in`.
29. **B29** A `/login#access_token=…&type=signup` link stores nothing, stays on `/login` and shows `login-confirmed`, whatever email its token names, the sign-up this browser started included (R193: an address someone else registered first keeps their password, and only a sign-in by hand exposes that). Its session is revoked, and `location.href` no longer holds the token.
30. **B30** A `type=recovery` link keeps its session for this tab only (memory, mirrored to `sessionStorage`; nothing in localStorage) and goes to `/reset-password`. An `error_code=otp_expired` link, in the fragment or the query, shows `login-link-error` with the linkExpired message and the resend and forgot actions. `error_description` is not rendered.
31. **B31** `/reset-password` with a recovery session shows the address and validates the new password like sign-up, plus a matching `reset-confirm`. It sends `PUT /auth/v1/user`, writes the session and goes to `/decks`. Without a recovery session it shows `reset-no-link` with `reset-request-new` and `reset-back-to-sign-in`.
32. **B32** A session within `AUTH_SESSION_REFRESH_MARGIN_SECONDS` of `expiresAt`, or one that `/api/auth/me` answers 401, is renewed once through `grant_type=refresh_token`, and `/api/auth/me` is retried with the new token. Concurrent renewals send one request.
33. **B33** When the provider refuses a refresh, the session is cleared and the gate sends the browser to `/login?reason=expired`, which shows `login-session-expired`. A session with no refresh token behaves as before: a 401 goes to plain `/login`.
34. **B34** Sign-out posts `/auth/v1/logout?scope=local` with the access token and `keepalive`, never awaited, then clears both storage keys and loads `/`.
35. **B35** No destination is ever read from a URL. Every post-auth navigation goes to a `paths` value, and `/login?next=https://evil.example` followed by a sign-in lands on `/decks`.
36. **B36** No source file under `apps/web/src` uses `dangerouslySetInnerHTML` or assigns `innerHTML`. Test files are not scanned: they are never bundled (the integration branch narrowed this when the effects layer's tests built fixture DOM that way).
37. **B37** `/` renders `LandingRoute` with CTAs to `/practice` (Play vs AI), `/play` (Play online) and `/decks` (Build decks). The corner slot holds `landing-sign-in` when anonymous, `landing-account` when signed in, and nothing while loading, for at most `GATE_SLOW_NOTICE_SECONDS`, after which it offers what this device's storage suggests.
38. **B38** The hero shows the `JackiOh` wordmark and an `aria-hidden` fan of five cards (`landing-fan-card-0..4`). `data-motion` is `reduced` under `prefers-reduced-motion`. The four `landing-step-<i>` tiles state `MAX_MANA`, `UNIT_ZONES`, `DECK_SIZE` and `LOADOUT_DECKS` from config.
39. **B39** At 360, 390, 768 and 1280 px wide, neither the landing nor the code field overflows horizontally (`documentElement.scrollWidth <= innerWidth`), and every landing CTA and the invite input are visible.
40. **B40** The gate's error panel offers `gate-retry` (which re-reads `/api/auth/me` and opens the gate when it succeeds), `gate-home` and `gate-sign-out`. The banned panel offers `gate-home` and `gate-sign-out`, and the 404 panel offers `not-found-home`.

## Tests

The tests are all new files, written from the behaviours above by the two tester groups. Existing
test files that a behaviour change breaks are fixed by the slice that owns the change (see Slices).

| Behaviours | Vitest project (directory) | File | Harness |
| --- | --- | --- | --- |
| B1-B4, B16 (`formattedCaret`) | `shared` (`packages/shared/test`) | `codes.test.ts`, plus the table `fixtures/code-input-cases.ts` | Plain vitest, table-driven over `CODE_INPUT_CASES` with `INVITE_CODE_FORMAT` from `apps/server/src/config.ts`. Names `it("R191 …")`. |
| B5, B6 | `server` (`apps/server/test/api`) | `code-input-parity.test.ts` | `createTestDeps` + `createRouter(createCodesRoutes(), deps)` + `jsonRequest` from `test/fakes/deps.ts`, on `systemTimers` with `testLimits()`' 20 ms floor (as `codes.test.ts` does). `Ids.code` returns the row's canonical code, with a fresh profile and IP per row so steps 2 and 3 never bite. Names `it("R191 …")`. |
| B7, B8, B13 | `server` | `redeem-feedback.test.ts` | Same harness; seeds attempts with `store.codes.logAttempt`. B8 asserts the `invalid_code` bytes and headers next to the 429 ones. Names `it("R192 …")`. |
| B9 | `server` | `redeem-feedback.test.ts` | `createManualTimers` with `createRateLimiter` directly, plus a router burst over `LIMIT`. |
| B10-B12 | `server` | `client-address.test.ts` | `clientAddress` unit rows; the router with hand-built `Request`s carrying multi-entry `x-forwarded-for` and a `RequestContext`; `loadEnv` with a full valid env record plus `TRUSTED_PROXY_HOPS`; `deps.log.entries`. Names `it("R190 …")`. |
| B14 | `server` (`apps/server/test/db`), and `db` via `pnpm test:db` | `redeem-race.ts` (exports `runRedeemRaceContract(harness)`), `redeem-race.memory.test.ts`, `redeem-race.postgres.spec.ts` | `memoryHarness` / `postgresHarness` from `test/db/harness.ts`, with `Promise.all` over `store.redeem`. The Postgres file needs Docker (`pnpm test:db`). |
| B15-B19 | `web` (`apps/web/src/auth`) | `CodeField.test.tsx` | jsdom + testing-library, rendering `<CodeField>` in a stateful wrapper. Paste uses `fireEvent.paste` with `clipboardData.getData`. Rows the paste handler does not fill fall back to `fireEvent.change`. Table-driven over `CODE_INPUT_CASES` imported from `../../../../packages/shared/test/fixtures/code-input-cases.ts`. Names `it("R191 …")`. |
| B20-B23 | `web` (`apps/web/src/routes`) | `invite-feedback.test.tsx` | `vi.mock("../net/api.ts")` exactly as `invite.test.tsx` does, and a session seeded under `E2E_SESSION_STORAGE_KEY`. `ApiRequestError(429, { code: "rate_limited", message, details: { retryAfterMs } })`. |
| B24 | `web` (`apps/web/src/auth`) | `validation.test.ts` | Pure. |
| B25-B28, B32 (single flight), B34 | `web` (`apps/web/src/net`) | `auth-flows.test.ts` | `vi.stubGlobal("fetch")` and `vi.stubEnv("VITE_SUPABASE_URL" / "_PUBLISHABLE_KEY")`, as `auth.test.ts` does; one test row per cell of the classification table. Names `it("R192 …")` for the 429 rows and `it("R194 …")` for refresh and revoke. |
| B24, B26-B30, B33, B35 | `web` (`apps/web/src/routes`) | `login-flows.test.tsx` | Renders `LoginRoute` with `history.replaceState` to the link URL before the render, `vi.useFakeTimers` for the cooldown, and a stubbed `fetch`. Names `it("R193 …")`. |
| B29, B30 | `web` (`apps/web/src/auth`) | `redirect.test.ts` | Pure `parseAuthRedirect` over `new URL(…)`; `consumeAuthRedirect` against jsdom's location. Tokens are unsigned three-part JWTs with a base64url JSON payload. Names `it("R193 …")`. |
| B31 | `web` (`apps/web/src/routes`) | `reset-password.test.tsx` | `holdRecoverySession` before the render, and a stubbed `fetch`. |
| B32, B33 | `web` (`apps/web/src/net`) | `gate-refresh.test.tsx` | Renders `App` from `main.tsx` (`await import`, as `gate.test.tsx` does) with a stubbed `fetch` that answers `/api/auth/me` 401 and then 200, and the token endpoint. Names `it("R194 …")`. |
| B36 | `web` (`apps/web/src/auth`) | `no-raw-html.test.ts` | `import.meta.glob("../**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true })`. No `node:fs`, because the web tsconfig has no Node types. |
| B37, B38 | `web` (`apps/web/src/routes`) | `landing.test.tsx` | jsdom; `setReducedMotion` from `src/test/setup.ts`; a stubbed `fetch` for `/api/auth/me`. |
| B40 | `web` (`apps/web/src/routes`) | `shell-exits.test.tsx` | `App` and `Gated` from `main.tsx`, with `/api/auth/me` failing and then succeeding. |
| B39 (and B15, B37 visually) | Cypress component | `e2e/cypress/component/landing-and-code-field.cy.tsx` | `cy.mount` (`support/component.tsx`) of `LandingRoute` and a `CodeField` inside `.app-shell > .panel--auth`, at 360×740, 390×844, 768×1024 and 1280×720. Run with `E2E_COMPONENT_PORT=5285 pnpm --dir e2e test:component`. |
| B16-B18, B22, B23, B29, B30, B31, B37, B40 end to end | Cypress e2e | `e2e/cypress/e2e/14-landing-and-sign-in.cy.ts` | **No server and no provider.** Every `${apiUrl}/api/*` call is a `cy.intercept` stub; sessions are seeded under `jackioh.e2e.session` in `onBeforeLoad`; links are visited as `/login#…`. The spec never submits to the provider (a `build:e2e` has no `VITE_SUPABASE_URL`). Paste goes through a dispatched `ClipboardEvent` with a `DataTransfer`. Run it with `pnpm build:e2e`, then `pnpm --dir apps/web exec vite preview --port 5175 --strictPort`, then `E2E_BASE_URL=http://localhost:5175 pnpm --dir e2e exec cypress run --spec cypress/e2e/14-landing-and-sign-in.cy.ts`. |

Regression specs the change can affect:

- `10-invite-gate.cy.ts`, which is networked: `E2E=1 PORT=8785 pnpm --dir apps/server start` with `--expose apiUrl=http://localhost:8785,wsUrl=ws://localhost:8785/ws/match` and `PUBLIC_ORIGINS=http://localhost:5175`;
- `09-deckbuilder.cy.ts`;
- the existing component spec `board-layout.cy.tsx`, which must stay green because no global CSS changes.

`packages/engine/test/rulings.test.ts` (slice A) gets index rows R190-R194, which point at the files
named above through `provenIn`.

## Out of scope

- The `/practice` route and the AI. Task 3 builds them. This branch only links to `/practice`, which
  shows the 404 panel until task 3 merges.
- PKCE flow (brought in later, on 2026-09-25: the three mailers send a PKCE challenge and `/login`
  exchanges the returning code, R323, R324), magic-link or OTP sign-in, OAuth providers, CAPTCHA,
  MFA, email change and account deletion.
- The server's fixture-only `/api/auth/signup` and `/api/auth/signin` (R160 already covers them), and
  §9.4's optional trusted devices.
- (Brought into scope by the panel for the account's own tries: `CodeStore.oldestAttemptAtByProfile`.) An exact "try again at" time for redemption. It would need a new `Store` port method on both stores
  and `test:db`. R192's upper bound stands in for it.
- The room-code field on `/play`. Its server side gains the new reading for free through
  `normalizeCode`; its UI is unchanged.
- Real card faces or art in the landing fan (task 6 at integration), fx or sound on the landing
  (tasks 1 and 2), and the settings panel (task 7).
- Web fonts, images and any new runtime dependency.
- Any schema change. (The panel's IP race needed one function change, migration 0006; `test:sql` is untouched.) `test:db` runs the new
  race contract.
- Internationalisation.

## Slices

Each existing file belongs to exactly one slice. The test files listed under a slice are existing
tests that the slice must keep green, or update where its behaviour change breaks them. New test
files belong to the testers. `apps/web/src/index.css` belongs to nobody and is not edited.

### Slice A: code reading, redemption and client-address hardening (server and shared)

Owns:

- `packages/shared/src/codes.ts` (new)
- `packages/shared/src/index.ts`: adds `export * from "./codes";` only
- `apps/server/src/config.ts`: additions only, the full constant list in Surface, the auth and web ones included
- `apps/server/src/env.ts`
- `apps/server/src/index.ts`
- `apps/server/src/api/crypto.ts`, `codes.ts`, `http.ts`, `cors.ts`
- `apps/server/src/api/ports.ts`: `ServerDeps.trustedProxyHops` only
- `apps/server/src/api/e2e-store.ts`: `createInMemoryRedeem` only
- `apps/server/.env.example`
- `render.yaml`: `TRUSTED_PROXY_HOPS: "1"`
- `docs/architecture.md`: a §8.2 row for `TRUSTED_PROXY_HOPS` and a §10 checklist line on verifying it through the `api.forwarded_for` log
- `SPEC.md`: the §9.4 bullet and the §11 rows R190-R194, inserted after R170 in numeric position
- `packages/engine/test/rulings.test.ts`: index rows R190-R194 only

Keeps green: `apps/server/test/api/{codes,rate-limit,cors,auth,e2e,catalog,loadouts,queue,results,collection}.test.ts`, `apps/server/test/db/*`, `apps/server/test/match/*`.

Behaviours: B1-B14.

### Slice B: code entry on the invite screen (web)

Owns:

- `apps/web/src/auth/CodeField.tsx` (new)
- `apps/web/src/auth/code-field.css` (new)
- `apps/web/src/auth/codeInput.ts` (new)
- `apps/web/src/routes/invite.tsx`
- `apps/web/src/net/api.ts`
- `e2e/support/testids.ts`: additive, the A13 block only, mirroring the new `inviteTestid` and `codeFieldTestid` names

Keeps green and updates `apps/web/src/routes/invite.test.tsx`. Its R104 test now asserts that an excluded character is refused, not dropped, and `inviteCodeCharacters` is gone.

Imports without owning:

- `inviteTestid`, `codeFieldTestid` and `codeFieldSegmentTestid` from `auth/testids.ts` (slice C);
- `signOut` from `routes/account.tsx` (slice C);
- `BackLink` from `routes/nav.tsx` (slice D).

Behaviours: B15-B23.

### Slice C: sign-in, sign-up, reset and session (web)

Owns:

- `apps/web/src/auth/testids.ts` (new; exactly the literal in Surface)
- `apps/web/src/auth/validation.ts` (new)
- `apps/web/src/auth/redirect.ts` (new)
- `apps/web/src/auth/auth.css` (new)
- `apps/web/src/net/auth.ts`, `gate.ts`, `session.ts`, `navigate.ts`
- `apps/web/src/routes/login.tsx`
- `apps/web/src/routes/reset-password.tsx` (new)
- `apps/web/src/routes/account.tsx`

Keeps green: `apps/web/src/net/auth.test.ts`, `apps/web/src/routes/login.test.tsx`, `apps/web/src/routes/account.test.tsx`.

Behaviours: B24-B36.

### Slice D: landing page and shell exits (web)

Owns:

- `apps/web/src/routes/landing.tsx` (new)
- `apps/web/src/routes/landing.css` (new)
- `apps/web/src/main.tsx`: extracts `Landing`, adds the `/reset-password` route line, the gate and 404 exits, and `redirectFor`'s expired case
- `apps/web/src/routes/nav.tsx`: additive only, if a helper is wanted
- `e2e/README.md`: additive, a row for spec 14 and a note that it stubs the API with `cy.intercept` and needs no server

Keeps green: `apps/web/src/routes/gate.test.tsx`.

Imports without owning:

- `landingTestid`, `shellTestid` and friends from `auth/testids.ts`;
- `paths.practice`, `paths.resetPassword` and `loginPath` from `net/navigate.ts`;
- the `Account` type with `reason` and `retry` from `net/gate.ts`;
- `signOut` from `routes/account.tsx`;
- `ResetPasswordRoute` by the path `./routes/reset-password.tsx`.

Task 3 later adds its own `/practice` route line in `main.tsx`. Keep the route table as a flat list of `if` lines so that line merges.

Behaviours: B37-B40.

## SPEC changes

### §9.4: a new bullet after "Codes: …"

> - The client's code screen and sign-in screens are UX over the rules above and decide nothing the
>   server does not. The code is typed into one field drawn as four groups, read exactly as the server
>   reads it (R191), and submitted only when complete, so a partial code costs no attempt. The screen
>   shows how many attempts the account has left in the window. A refusal at steps 2 or 3 is shown as
>   a rate limit with its wait (R192), never as the identical error. Sign-in, sign-up, confirmation
>   resend and password reset go straight to the auth provider (§9.2). Every refusal is mapped to the
>   client's own sentence, and none reveals whether an account exists (R160, R192). Emailed links are
>   read once and scrubbed from the address bar (R193), and a session is renewed or ended as R194
>   says. Every screen on the way (landing, sign-in, reset, the code screen, the gate's own panels)
>   offers a way back. The per-IP limit of step 3 counts the address R190 names.

### §11: new rows, inserted after R170 in numeric order, with matching `rulings.test.ts` index rows

| # | Topic | Recommended ruling | Cards affected |
| --- | --- | --- | --- |
| R190 | Which address a per-IP limit counts | §9.4 step 3 and R157 key on "the IP hash". Behind a proxy, a request arrives from the proxy's address, so the client's address is read from `X-Forwarded-For`, but only from the entry the deployment's own proxies wrote. The server trusts `TRUSTED_PROXY_HOPS` hops and takes that many entries from the **right**. Everything to the left of that entry was written by the caller and is ignored, and so are `CF-Connecting-IP` and `X-Real-IP`. A request carrying fewer entries is keyed on the socket's peer address. The default (`DEFAULT_TRUSTED_PROXY_HOPS`) is 0, which ignores the header: with no proxy in front, every entry is the caller's, so a deployment behind a proxy must say how many hops it has, counted from its own requests (docs/architecture.md says how; Render's blueprint starts at 1, which can only over-group). Reading the leftmost entry, as the server once did, let a caller choose a fresh bucket for every request by changing one header, which made both per-IP limits no limit at all. Too few trusted hops can only over-group callers behind a proxy; too many hands the key back to the caller. So the server logs the **fewest** entries any request has carried: a caller can add entries but never remove its proxies', so that minimum is the hop count, and one sample (which a caller may have written) is never the calibration. The address is then keyed as a network, not a host: an IPv4 address whole, an IPv6 address by its first `IPV6_RATE_LIMIT_PREFIX_BITS` bits (a /56: a line or a cloud host is handed at least a /64, so the full address would give one host 2^64 buckets, and many ISPs delegate a whole /56 to one home, so keying on the /64 would still give it 256; the price is that IPv6 neighbours sharing a /56 share a bucket), and an IPv4-mapped IPv6 address as its IPv4 address | §9.4, §9.8, R157 |
| R191 | How a typed or pasted code is read (extends R104) | Client and server read a code the same way, through one shared function: Unicode compatibility normalisation (NFKC), upper case one character at a time, and every space, dash and invisible separator removed. What remains must be exactly the code's length in R104's alphabet. A character the alphabet leaves out (`0`, `1`, `I` or `O` after upper-casing) is never dropped, mapped or guessed at. The server treats the input as malformed (R145's identical error), and the client refuses the keystroke and names the character. Dropping it, as the code screen once did, shifts every later character and turns a typo into a different code. Mapping it the way Crockford's base32 does is impossible here, because both halves of each look-alike pair are excluded. Input longer than `CODE_INPUT_MAX_LENGTH` is malformed without being read, so config bounds the work a redemption does, not the caller | §9.4, §9.5, R104, R145 |
| R192 | A rate limit is reported as a rate limit | A refusal because the caller is going too fast is shown as exactly that, with how long to wait. That covers §9.4 steps 2 and 3, R109's API limit and the auth provider's own limits. It is never folded into R145's identical code error or R160's identical sign-in error. R145 is not weakened: a rate limit depends on the caller's own account or address, or on the service, never on whether a code exists. R160 has one carve-out, sign-up's own 429 for the mail interval, named at the end of this row. The API states the wait as `Retry-After` and `details.retryAfterMs`. For a redemption refused at step 2 or 3 the wait is the whole attempt window, an upper bound, because the exact time would depend on the IP window and so on other accounts' attempts. The code screen's status does say exactly when this account's own tries come back (its oldest counted attempt leaving the window), and when a paused breaker reopens, and the screen reads the status again then, so neither state waits for a reload. Every wait the screen states is a deadline on the clock: its sentence counts down, and a page shown again after it passed acts at once, since a sleeping tab's timers are frozen. A redemption refused because redemption is paused (a 503, which the database's own switch answers too) turns Redeem off at once, and the server keeps saying paused in its status from then on, so a player does not spend tries on a paused service. Two provider requests are an exception. Resending a confirmation and asking for a password reset answer the same neutral sentence for every provider answer except an unreachable provider and an invalid address, because the provider answers an unknown address without ever reaching its mailer: a rate limit (its per-address interval), a failed send or an allow-list refusal can only happen to an address that has an account. Instead, the client waits out the provider's per-address interval (`AUTH_EMAIL_RESEND_COOLDOWN_SECONDS`) for the address it mailed, a sign-up included, before it offers that address the button again. The interval is counted on the clock from the send this browser remembers, so a reload or a tab the browser put to sleep neither restarts nor stalls it; a send this browser does not remember (another device's) starts nothing here. The neutral sentence says, for every address alike, that a send asked for inside the interval (from any device) cannot go out yet, and the wait beside the button says only how long, never that a mail went out. Sign-up's own 429 for the mail interval is the one provider signal left visible, and so R160's one carve-out: the provider gives it to any direct caller whatever the client says, it only tells that an unconfirmed sign-up for the address was mailed in the last interval, and the same answer is the project's overall mail limit, which a new player must be told about rather than sent to an empty inbox | §9.4, §9.8, R109, R145, R160 |
| R193 | What an emailed auth link may do | A confirmation or recovery link carries its tokens in the URL fragment. The client reads them once and removes them from the address bar and history before anything renders, on whatever path the link lands (the provider falls back to the project's Site URL), and the link is then handled on the sign-in screen. It then goes to a fixed route, never to a URL found in a query string or fragment. The provider's own error text is never shown: a known error code maps to the client's own sentence. A **confirmation** link never signs this browser in, not even for the sign-up this browser started: the email is confirmed (the provider did that when the link was opened), the session the browser already has is untouched, and the player is asked to sign in with their password. Accepting a token from a link would let an attacker sign a victim into the attacker's pending account, where the victim's own invite code would activate the attacker. Nor is a link proof of the password: the provider leaves an existing unconfirmed account unchanged when the same address signs up again, so an address someone else registered first keeps that person's password through the owner's own sign-up and confirmation, and a session taken from the link would hide it for as long as renewal lasts. Signing in by hand exposes it: the owner's password is refused, and the reset that follows replaces the other one. A **recovery** link is held (for the reset screen, never as the stored session) at once if its address matches a reset this browser asked for. Otherwise (a reset asked for on another device or in another browser, which is the common case) nothing is held until the player types their account's address, and the link is held only if that matches its checked address. Someone sent another person's link types their own address, which does not match, so they are not signed into that account, and the session this browser has is untouched; the owner on a second device gets through. Leaving that question revokes the link. The guard is only as good as the address it compares, so nothing from a link is ever shown or filled into a form, not even its checked address: a mailer form holding an address the player did not type would arm the guard with it at one click. Nor is anything filled in from storage: `/login?mode=forgot` is a public link, and the reset address a shared computer remembers may be another person's. A link's session is renewed once as soon as it is read, before the server is asked whose it is, because its tokens were in a URL that the browser's history keeps: the refresh token that URL carried is then spent whatever the tab does next (closing it while the link is being checked included), and everything after (the check, holding, revoking) uses the renewal. A renewal the provider refuses means the link was opened before, and nothing is held. A link's session that is not held (every confirmation, a reset whose address was not typed, a dashboard invite, a confirmation that could not be checked, one the player moved on from) is revoked, renewed first if its access token has run out (R194). A recovery link the game server could not check is kept on the sign-in screen, and only there, so it can be checked again (it works only once), and is revoked when the player moves on. The sign-in screen says when the browser already holds a session, and whose, because signing in replaces and revokes it. The recovery session lives in this tab only, in memory and mirrored to the tab's `sessionStorage` so a reload does not spend the reset, and never in `localStorage`. It becomes the stored session only once a new password is saved, and the reset screen says so when that will sign this browser out of another account. Leaving the reset screen unsaved abandons it (forgets and revokes it), but its own exits ask first, because the link works only once | §9.2, §9.4, §9.8, R160 |
| R194 | When a session is renewed and when it ends | An access token within `AUTH_SESSION_REFRESH_MARGIN_SECONDS` of expiring is renewed with the session's refresh token before it is used, and while a screen is open the gate renews that far ahead of the expiry of the token it handed down and hands down the new one, so a screen's own requests (a queue wait, a deckbuilder save) never carry an expired token. A renewal of the same session in another tab does not replace a token that still has longer than the margin to live, so nothing keyed on it (a match socket) is reopened for nothing. A token the API refuses as unauthorised when the gate or the code screen made the call is renewed once, and the request is retried. A session's expiry is counted on this device's clock, from the lifetime the provider states (`expires_in`), never from its absolute `expires_at`, so a device whose clock is off does not read a fresh session as expired. Concurrent renewals share one provider call, because the provider rotates refresh tokens and treats a reused one as stolen. A renewal the provider refuses ends the session, and the sign-in screen says so rather than failing silently. Signing out revokes the session at the provider as well as clearing the device, so a copied token cannot outlive the sign-out. The API honours an access token only while the provider still has its session: a token that names its session is checked with the provider, and only a live answer is remembered, for `AUTH_SESSION_LIVE_CACHE_SECONDS`, so a session ended by a sign-out, a revoked link or a password reset stops working at the API within that time rather than when its access token expires. A provider that cannot be reached signs nobody out (sign-in is down with it), and the email then counts as R159 says. The provider refuses to revoke with an expired access token, so an expired session is renewed first and then revoked (a signed-out session, and an abandoned recovery session or link, alike), with sign-out waiting at most `AUTH_SIGN_OUT_WAIT_SECONDS` for the two, and saying so; a second press meanwhile joins the first rather than leaving before the revocation is sent. A live one is revoked without waiting. A sign-out in another tab is noticed, since tabs share the session's storage. A session with no refresh token (the end-to-end fixtures) is never renewed. A recovery session held for the reset screen (R193) is renewed the same way before the new password is sent, and once more if the provider refuses its access token, so a slow player is not told the link was spent; only a renewal the provider refuses means it was | §9.2, §9.4 |

The proving test files for each row:

| Row | Proved in |
| --- | --- |
| R190 | `apps/server/test/api/client-address.test.ts` |
| R191 | `packages/shared/test/codes.test.ts` (the shared table), `apps/server/test/api/code-input-parity.test.ts` (the server redeems every canonical row and answers R145's error for the rest), `apps/web/src/auth/CodeField.test.tsx` (the field refuses an excluded character, a composing keyboard included) |
| R192 | `apps/server/test/api/redeem-feedback.test.ts`, `apps/web/src/net/auth-flows.test.ts`, `apps/web/src/routes/login-flows.test.tsx`, `apps/web/src/routes/invite-feedback.test.tsx` |
| R193 | `apps/web/src/auth/redirect.test.ts`, `apps/web/src/routes/login-flows.test.tsx`, `apps/web/src/routes/reset-password.test.tsx`, `apps/web/src/routes/shell-gate.test.tsx` |
| R194 | `apps/web/src/net/gate-refresh.test.tsx`, `apps/web/src/net/gate-session-changes.test.tsx`, `apps/web/src/net/auth-flows.test.ts`, `apps/web/src/routes/invite-feedback.test.tsx`, `apps/web/src/routes/reset-password.test.tsx`, `apps/server/test/api/auth.test.ts` |

## Risks

- **Render's forwarded chain is unverified.** One trusted hop is spoof-proof whether Render
  overwrites or appends to `X-Forwarded-For`. If Render adds more than one entry (a Cloudflare edge,
  for instance), everyone behind that edge shares one per-IP bucket, and §9.4's 20 per hour could
  refuse strangers. The `api.forwarded_for` log reports the fewest entries any request carried, and
  `docs/architecture.md` (§10, step 8) tells the operator to set `TRUSTED_PROXY_HOPS` to the count
  their own header-less request shows, never above the lowest count seen. `render.yaml`'s 1 is a
  starting point until that is done, not a verified count.
- **Supabase's redirect allow-list.** All three emails (confirm, resend and reset) still point at
  `/login`, which is already allow-listed, so no new Redirect URL is needed. If the deployed origin is
  missing, the links fall back to the Site URL (the known `localhost:3000` trap).
- **Mail scanners use up one-time links** (Outlook Safe Links), so the player sees `otp_expired`. The
  expired-link screen offers resend and reset right there. Nothing in our code can stop the prefetch.
- **Confirming always needs a manual sign-in**, on this device or another. This is intended (R193):
  the page says "Your email is confirmed. Sign in to continue." The address is not filled in: a link
  can be anyone's (see "After the second panel round"), and a link is no proof of the password (see
  "After the third panel round").
- **The API asks the provider whether a session is live** (R194), once per session per
  `AUTH_SESSION_LIVE_CACHE_SECONDS`. That is one extra provider round trip per active session every
  half minute, and a request that pays for it waits on the provider (bounded by
  `AUTH_PROVIDER_TIMEOUT_SECONDS`). An unreachable provider signs nobody out.
- **GoTrue's error shapes vary by version** (`error_code` against `error`). The classification keys
  on the status first and treats an unknown code as the endpoint's generic refusal, so an unfamiliar
  shape can only make a message less specific, never leak one.
- **Refresh-token rotation across tabs.** Single flight covers one tab. Two tabs renewing at once
  depend on GoTrue's reuse interval (10 s by default). A losing tab sees `sessionEnded` and asks the
  player to sign in again.
- **`attemptsRemaining` is advisory.** It uses `>=` on the attempt time while the SQL uses `>`, so it
  can be off by one attempt in the boundary second. The per-IP window can also refuse before it
  reaches zero on a shared network, and the 429 panel covers that case.
- **The transparent-input field.** Caret mapping and selection are the fiddly part. The builder must
  keep the input visible to Cypress (`color: transparent` only) and keep spec 10's type-then-assert
  flow green: its placeholder, its formatted value and `invite-error` with exactly the server's text.
- **The client bundle imports `apps/server/src/config.ts`,** as it already does. Only public
  constants may ever live in that file. A secret added there later would ship to browsers, and the
  header comment must say so.
- **Merge surfaces:**
  - `main.tsx`: task 3's `/practice` route line.
  - `navigate.ts`: the identical `practice` line.
  - `SPEC.md` §11 and `packages/engine/test/rulings.test.ts`: every task inserts rows, so resolve in numeric order.
  - `e2e/support/testids.ts`: other tasks' blocks.
  - `packages/shared/src/index.ts`: one line.
  - Spec number 14 could collide with another task's new spec; renumber at integration.
- **The Play vs AI CTA leads to the 404 panel on this branch alone,** until task 3 merges. The
  integration branch wires it.

[hs-menu]: https://hearthstone.wiki.gg/wiki/Main_menu
[hs-box]: https://medium.com/@matt.tsui/hearthstone-design-thinking-inside-the-box-78dbacb96040
[hs-gdc]: https://www.gamedeveloper.com/design/video-designing-an-immersive-user-interface-for-i-hearthstone-i-
[hs-uidb]: https://www.gameuidatabase.com/gameData.php?id=628
[otp-lib]: https://github.com/guilhermerodz/input-otp
[otp-single]: https://dev.to/madsstoumann/using-a-single-input-for-one-time-code-352l
[otp-fem]: https://frontendmasters.com/blog/html-css-for-a-one-time-password-input/
[crockford]: http://www.crockford.com/base32.html
[xff-adam]: https://adam-p.ca/blog/2022/03/x-forwarded-for/
[xff-mdn]: https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/X-Forwarded-For
[xff-render]: https://feedback.render.com/features/p/send-the-correct-xforwardedfor
[owasp-fp]: https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html
[sb-resend]: https://supabase.com/docs/reference/javascript/auth-resend
[sb-otp]: https://supabase.com/docs/guides/troubleshooting/otp-verification-failures-token-has-expired-or-otp_expired-errors-5ee4d0

## After the adversarial panel

The panel (security, UX and correctness lenses) confirmed these findings, and each now has a fix and
a test. SPEC's R190 and R192 to R194 were amended to match, and the rows above are the amended ones.

Server:

- **The per-IP window raced in Postgres.** `app.redeem_invite_code` counted step 3's attempts with
  no lock across profiles, so concurrent redemptions from different profiles at one address all
  passed (7 to 9 lookups where §9.4 allows one). Migration `0006_redeem_ip_lock.sql` takes a
  transaction-scoped advisory lock on the IP hash before the count. `test/db/redeem-race.ts` runs the
  boundary burst against both stores. The breaker's global count stays unlocked on purpose (a
  monitoring threshold; locking it would queue every address behind one flood).
- **The in-memory stores shared one snapshot between concurrent transactions.** `tx` now runs one
  transaction at a time (`createTransactionQueue`), a nested one joining through `AsyncLocalStorage`.
- **Trusted hops default to 0**, not 1: with no proxy in front, the header is the caller's.
  `render.yaml` sets 1 explicitly. Test deps set 1, because `jsonRequest` writes the entry a proxy
  would.
- **IPv6 clients are keyed by their /56** (`IPV6_RATE_LIMIT_PREFIX_BITS`; a home is often delegated
  a whole /56, so a /64 key still gave one 256 buckets), and an IPv4-mapped address as its IPv4
  address (`rateLimitAddress` in `http.ts`).
- **`api.forwarded_for` reports the fewest entries seen**, logged each time a lower count appears
  (capped, so a caller can cause only a handful of lines). A single first sample could be a
  scanner's own entries. The docs no longer say to raise the hops to match a count.
- **`GET /api/codes/status` says when a try comes back** (`attemptsRetryAfterMs`, from the new
  `CodeStore.oldestAttemptAtByProfile`).

Client:

- **A recovery link is accepted only for an address this browser asked to reset**
  (`jackioh.auth.pendingReset`), the login-CSRF guard confirmation links already had. Anything else
  holds nothing, leaves the current session alone and says to open the link where it was asked for.
  The reset screen says when saving will sign the browser out of another account.
- **An auth link on any path** is scrubbed at boot and handed to `/login` (`adoptAuthRedirect`).
- **Resend and forgot-password are neutral for every provider answer** but an unreachable provider
  and an invalid address: a failed send or an allow-list refusal only happens to a known address.
  Sign-up's own 429 stays visible, as R192 now explains.
- **Sign-out renews an expired session so it can revoke it**, waiting at most
  `AUTH_SIGN_OUT_WAIT_SECONDS`.
- **One gate per screen** (`<Gated key={path}>`): a redemption no longer bounces back from `/decks`,
  and a sign-out in another tab (a `storage` event) or on the next move is noticed.
- **A redemption refused as unauthorised is renewed and retried** (R194); a 409 re-reads the account.
- **Pasted text**: a four-letter word beside a code is a word (`findCodeInText` reads chains of
  words), and a code with an extra group joined on is not cut down to 16 characters. Text inserted
  without a paste event is read the same way.
- **The code field**: Delete and the arrow keys no longer stick on a separator.
- **The code screen**: waits are stated and lift by themselves; a per-IP 429 hides the count and
  blames no one; the identical error clears when the code is edited; "Redeeming…" while in flight;
  an active account gets "Go to your decks" instead of a form.
- **The shell**: an error boundary for a chunk that fails to load; "Checking your account…" offers
  home and sign-out after `GATE_SLOW_NOTICE_SECONDS`; API and provider requests time out
  (`API_REQUEST_TIMEOUT_SECONDS`, `AUTH_PROVIDER_TIMEOUT_SECONDS`); the error panel says a transport
  failure plainly and counts down a rate limit's wait.
- **Copy**: `weak_password` follows the provider's reasons and states no number; an expired link
  says a confirmed player can just sign in; the reset form carries a username for password managers;
  a shown password is never auto-capitalised, corrected or spell-checked; the resend and reset
  intervals belong to the address mailed, a sign-up's included.

## After the second panel round

A second adversarial round (security, UX and correctness lenses) confirmed these, and each now has a
fix and a test. SPEC's §9.4 bullet, R190, R192, R193 and R194 were amended to match, and the rows
above are the amended ones.

Security:

- **Nothing from a link is filled into a form.** The confirmed, recovery-refused and invite outcomes
  used to fill the checked address into the form, and one press of "Send reset link" (or a failed
  sign-in and "Resend") then armed `pendingReset` or `pendingEmail` with an address the player never
  typed, after which the same person's next link was accepted. The fields now start empty.
- **A link's session that is not kept is revoked** (another device's confirmation, someone else's
  reset, a dashboard invite, one that could not be checked, one the player moved on from): its tokens
  were in a URL the browser's history keeps. The reset screen abandons (revokes) its session when it
  unmounts unsaved, just after the unmount so StrictMode's rehearsal does not.
- A link's `type` is still read from the fragment unverified, and that is deliberate: it only picks
  which of the address checks applies, and an attacker can mint a genuine confirmation or recovery
  token for their own account at will, so a verified type would stop nothing the address guard does
  not.

Client:

- **A code refused with R145's error is not sent again unchanged**: Redeem stays off, and says why,
  until the code changes. The field is locked while a code is being redeemed. The code screen starts
  again for another account (a sign-in in another tab), keyed by the profile.
- **An unconfirmed email on the code screen** is said above the form, with a resend and a "Check
  again" that reads the account again; the server's `email_unverified` refusal shows the same.
- **The mail interval** is counted on the clock from the send this browser remembers
  (`auth/cooldown.ts`), so it survives a reload and a sleeping tab, and a recovery link opened on
  another device holds the form for its address. The neutral notices say a send inside the interval
  cannot go out, for every address alike. The gate's stated waits use the same clock.
- **The reset screen's exits ask first** ("Leave without saving?"), since the link works only once. A
  recovery session that runs out while the form is open is renewed before the password is sent.
- **Pasted chat messages**: a neighbour joined like the code's groups no longer blocks it when no
  code could hold that word (`couldBelongToCode`), and a message with more letters and digits than a
  code keeps the field's old value and quotes the paste instead of keeping a word of it.
- **The code field draws a selection** (`data-selected`) and hides its caret while one stands.
- **Where a player was going**: a sign-in returns to the gated screen that sent the player to it
  (`net/return-to.ts`: a fixed allow-list of `paths` values in `sessionStorage`, never a URL, B35).
- **A pending account's account screen** shows its address and status from the gate's read and links
  to the code screen, instead of `/api/profile`'s 403.
- **The landing's corner** offers its link after `GATE_SLOW_NOTICE_SECONDS` while a sleeping server
  wakes. Notices sit above the sign-in form, a successful sign-up moves focus to its notice, and a
  refused field takes focus.
- **Copy**: a wait of an hour reads "about an hour"; the foreign-character hint names the alphabet
  (and suggests a Latin keyboard for a letter from another script) instead of "capital letters"; the
  code screen no longer says codes come from other players.

Server:

- **An empty code** (`{"code": ""}`) is read like any other input holding no code: R145's identical
  error and a `malformed` attempt, after the account's own checks, instead of `bad_request`. The
  shared table has a row for it.


## After the third panel round

A third adversarial round (security, UX and correctness lenses) confirmed these, and each now has a
fix and a test. SPEC's R192, R193 and R194 were amended to match, and the rows above are the amended
ones.

Security:

- **A confirmation link never signs the browser in**, not even for the sign-up this browser started
  (account pre-hijack). GoTrue leaves an existing unconfirmed account unchanged when the same address
  signs up again: it mails the link again and answers 200. So a person who registered the player's
  address first kept their own password on the account the player then confirmed and activated, and
  the link's session, renewed for as long as the refresh token lived, never asked the player for
  theirs. Now the player signs in by hand, which exposes a password someone else set (the player's
  is refused, and the reset that follows replaces the other one). The link's session is revoked.
- **The API refuses a token whose session has ended** (R194). It used to honour any well-signed,
  unexpired token, so a sign-out, a revoked link or a reset that signed other devices out still left
  up to an hour of API access to whoever held the access token. A token that names its session is
  now checked with the provider (`GET /auth/v1/user`, which refuses an ended session), and only a
  live answer is remembered, per session, for `AUTH_SESSION_LIVE_CACHE_SECONDS`. That answer is also
  the authoritative user, standing in for R159's admin lookup when it is fresh.
- **Nothing is filled in from storage.** `/login?mode=forgot` showed the reset address this browser
  last asked for, which on a shared computer can be another person's, and one press then armed it for
  another day. The field starts empty.

Client:

- **The code screen's waits are deadlines.** "No tries left", "paused" and a 429's wait are read from
  the clock at each render and count down, and a page shown again after a wait passed acts at once
  (`visibilitychange`, `pageshow`, `focus`) instead of waiting on a timer the phone froze.
- **A 503 from a redemption is a pause**: Redeem goes off at once. The server now mirrors the
  database's own switch in its breaker when a redemption meets it, so `GET /api/codes/status` says
  paused and further presses are refused before the store logs another attempt.
- **"Check again"** says "Checking…", says when the address is still unconfirmed, and a check that
  cannot reach the server says so beside the typed code.
- **A background re-read keeps the screen** (`settleAccount` in `net/gate.ts`): one that fails keeps
  the account the screen has, and another tab's renewal of the same session does not replace a token
  with more than the margin to live (a match socket is no longer closed and reopened for it).
- **The gate keeps an open screen's token fresh**, renewing `AUTH_SESSION_REFRESH_MARGIN_SECONDS`
  before the token it handed down expires (a timer, and at once on waking), so `/play`'s match watch
  finds a pairing that crossed the hour and a deckbuilder save carries a live token.
- **Session expiry is counted on this device's clock** (`expires_in` from arrival), so a device an
  hour fast no longer drops every recovery link on arrival, and a held recovery session that has
  expired is renewed rather than dropped while it has a refresh token.
- **A recovery link the server could not check** gets its own notice with "Try again" and the forgot
  form (no confirmation resend), and is kept until the player moves on from it instead of being spent
  on a network blip.
- **Sign-out** says "Signing out…" and cannot be pressed twice while an expired session is renewed so
  it can be revoked, so a second press no longer leaves before the revocation goes out.
- **Smaller**: auth fields are 16px so iOS does not zoom on focus; the landing corner offers Account,
  not Sign in, to a device holding a session when `/api/auth/me` fails; "Checking your link…" explains
  a sleeping server after `GATE_SLOW_NOTICE_SECONDS`; the sign-in screen says which account the
  browser is already signed in as; resend is offered only after a `credentials` refusal; and the
  forgot form's locked button keeps its name, with one line under it saying how long to wait (the
  integration's fix stage: the button's own "Send in N s" said the wait a second time).

## After the visual pass

Screenshots of every screen and state at 1280×720, 390×844, 844×390 and 768×1024 showed the way in
as two different products: a warm tavern landing, then a cold blue developer form. These changes
came out of that pass. None changes a behaviour, a test id or a message.

- **One tavern for the way in.** The palette moved from `.landing` to `.tavern`
  (`apps/web/src/auth/tavern.css`). The landing, sign-in, reset, the code screen and the shell's
  own panels (the gate's waits and refusals, the 404 and a screen that failed to load) all carry
  it. The auth screens now sit on a framed wood board with brass trim and corner studs, over the
  landing's hearth light and table. They use the gold wordmark, a serif title between brass rules,
  sunken fields with a gold focus glow, the landing's gold call to action, wood secondary buttons,
  gold-for-a-message and ember-for-a-problem notices, and link buttons that line up with the form.
  Everything is scoped under `.tavern`, so `index.css` and the board are untouched.
- **The code field** shows slots cut into wood with brass dashes between them. A full group glows
  teal, the group the caret is in is lit gold (which replaces the ring around all four), and a
  refused character turns that group ember. The tries left carry a small gem, a refusal and its wait
  read as one message, and the example code never breaks across lines.
- **The landing** gets a layout for a phone on its side, so Play vs AI is on the first screen at
  844×390 (it was below the fold). It also gets a larger hand on desktop, a pool of hearth light
  under it, a table that fades into the dark instead of ending in a hard line, balanced wrapping for
  the kicker, and "How it plays" tiles that are two by two on a tablet (never three and one), with
  their text aligned.

## After the second visual pass

The same four viewports again, with a browser window large enough that the phone and tablet
captures are whole (the default headless window cut them off at 720 px). These changes came out of
it. No behaviour or test id changed; two sentences on the code screen did (below).

- **A phone on its side** sets each board in two parts: the wordmark, the title and any notice on
  the left, the form on the right, with a brass seam between them. Sign-in and reset also move Back
  beside the board. Every form's button is now on the first screen at 844×390 (sign-in's was 23 px
  below it, the code screen's 115 px). The screens mark the parts with `auth-board__head` and
  `auth-board__body` inside `panel--split`; everywhere else the parts are `display: contents`, so
  the one-column layout is exactly what it was. The component spec checks sign-in, create-account
  and reset at 844×390.
- **The code screen** is shorter between the field and Redeem. The "Invite code" label is kept for
  screen readers but no longer drawn, since the title above says the same. The format line
  ("16 characters in 4 groups, like …") is gone: the four slots and the count under them show the
  shape. What stays is one line, "Paste it as is: case and dashes don't matter." The invite-only
  note moved below Redeem, set apart by a hairline like the sign-in board's links, and starts
  "No code yet?". On a phone held upright Redeem moved from 619 px to 414 px down the page. The
  rate-limit line under the server's sentence now says only who and when ("This account or
  network can try again in about an hour."), where it used to repeat "too many tries … try again"
  after the server had just said it.
- **A phone held upright** gives the code screen's "Signed in as" and Sign out a row of their own
  under Back and the gear, where a long address wraps rather than ending in an ellipsis (the
  integration's fix stage: at 390 px the ellipsis never drew and the address ran off the screen).
  The auth boards sit closer under Back, because the keyboard takes the lower half of the screen
  once a field is tapped.
- **Addresses** break before their "@" (`auth/Address.tsx`, a `<wbr>`), not at whatever letter
  reaches the edge of a narrow column. A long address no longer runs out of a notice.
- **The landing.** "How it plays" has drawn icons in place of Unicode symbols: a teal mana crystal,
  the table's lanes in perspective, a stacked deck and a fan of decks. The lanes and decks are drawn
  from `UNIT_ZONES` and `LOADOUT_DECKS`, so the picture always matches the number beside it, and a
  unit test counts them. The tiles are one, two or four across by width; auto-fit gave three and one
  from about 780 to 1030 px, a phone on its side included, and the component spec now checks row
  lengths at five widths. On a desktop the hand is dealt larger and lifted level with the wordmark
  and the buttons. The fan's cards have an engraved name and three lines of rules text. They are
  still decoration until task 6's `CardFace` replaces them. The kicker sits clear of the Sign in
  pill on a phone.

## After the review

Three reviewers read the branch. What changed because of them:

- **A reset works from another device.** A recovery link whose address is not a reset this browser
  asked for used to be revoked on sight, and the forgot form was then held for a minute. Asking on a
  laptop and opening the email on a phone (or in a mail app's own browser) is the usual way people
  reset, so it always failed the first time. Now such a link waits on the sign-in screen
  (`claimReset`) until the player types their account's address, and is held only if that matches
  the checked address. The login-CSRF guard stands: someone sent another person's link types their
  own address, which does not match. The link's address is still never shown or filled in. Leaving
  the question revokes the link, and no wait is started for an address this browser never mailed.
- **A link is renewed as soon as it is read.** Its refresh token was in a URL the browser's history
  keeps, and it was revoked only by in-page code that a closed tab never ran. `/login` now spends it
  (one renewal) before the server is asked whose it is, then checks, holds or revokes the renewal. A
  renewal the provider refuses (the link was opened before) holds nothing.
- **An expired session is renewed before it is revoked**, for an abandoned reset and a link as for
  sign-out, since the provider refuses to revoke with an expired access token.
- **The gate's own renewal keeps a match socket up.** A new token no longer reopens the socket; it
  waits for the next reconnect. The match screen is keyed by the provider session, so only a
  different session (or account) opens a new socket.
- **The way in says what happened, once.** A redeemed code ends on a "You're in" board with the way
  on to the decks. The forgot form's hint says only how long to wait. The resend button has a
  lead-in, a weak password names every rule it broke, the Account screen wears the tavern frame and
  says a status in words, the 404 panel speaks to a player, and the code screen names who hands out
  codes.
- **The code field lets a composing keyboard finish.** It shows an IME composition as written and
  reads, formats or refuses it only once the composition ends. This is covered with synthetic
  composition events only: try it on Android Chrome with Gboard, and on iOS Safari, before shipping.
- **Proxy hops are calibrated, not assumed.** `render.yaml` starts at 1, and `docs/architecture.md`
  says to set the count the operator's own header-less request shows.
- The landing fan's faces are still decoration; task 6's `CardFace` replaces them at integration.
