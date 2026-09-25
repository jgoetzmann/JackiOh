// `net/auth.ts`, the browser's arrow to the auth provider (SPEC §9.2), after polish 5
// (docs/polish/5-sign-in.md, B25-B28, B32, B34).
//
// Every provider answer maps to one AuthFailure, and the screen shows only AUTH_MESSAGES[failure]:
// the provider's own text is never relayed (R160). A rate limit reads as a rate limit (R192), except
// on resend and recover, which answer the same neutral way whether they sent or were limited,
// because the provider limits those per address. A session is renewed through one shared request
// and revoked without being waited for (R194).
//
// One test per cell of the classification table follows. The table is data here, row for row.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUTH_PASSWORD_MIN_LENGTH,
  AUTH_PROVIDER_TIMEOUT_SECONDS,
  AUTH_SIGN_OUT_WAIT_SECONDS,
} from "../../../server/src/config.ts";
import { signOut } from "../routes/account.tsx";
import {
  AUTH_MESSAGES,
  AUTH_UNCONFIGURED_MESSAGE,
  AuthError,
  SIGN_IN_FAILED_MESSAGE,
  SIGN_UP_FAILED_MESSAGE,
  authRedirectUrl,
  classifyProviderRefusal,
  exchangeAuthCode,
  refreshSession,
  requestPasswordReset,
  resendConfirmation,
  revokeSession,
  revokeSignedOutSession,
  sessionNearExpiry,
  signIn,
  signUp,
  updatePassword,
  type AuthEndpoint,
  type AuthFailure,
} from "./auth.ts";
import { challengeFor, challengeForRequest, storedVerifiers } from "../auth/pkce.ts";
import { paths } from "./navigate.ts";
import {
  E2E_SESSION_STORAGE_KEY,
  SESSION_STORAGE_KEY,
  pendingEmail,
  pendingReset,
  rememberPendingEmail,
  rememberPendingReset,
} from "./session.ts";

const URL_ = "https://project.supabase.co";
const KEY = "sb_publishable_test";
const EMAIL = "player@example.com";

/** R323: every mailer sends a PKCE challenge beside the address. */
const PKCE_FIELDS = { code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u), code_challenge_method: "s256" };
const PASSWORD = "x".repeat(AUTH_PASSWORD_MIN_LENGTH);
const ACCESS = "access-token-1";

/** GoTrue reports `expires_at` in seconds; the client keeps epoch ms. */
const EXPIRES_AT_S = 2_000_000_000;

const TOKEN_BODY = {
  access_token: "access-new",
  refresh_token: "refresh-new",
  expires_at: EXPIRES_AT_S,
  expires_in: 3600,
  token_type: "bearer",
  user: { id: "user-1", email: EMAIL },
};

/** Provider text that must never reach a message. */
const PROVIDER_TEXT = ["PROVIDER-MSG-7f3a", "PROVIDER-DESCRIPTION-7f3a", "PROVIDER-MESSAGE-7f3a"] as const;

// ---------------------------------------------------------------------------------------------
// the stubbed provider
// ---------------------------------------------------------------------------------------------

type Call = {
  url: URL;
  method: string;
  headers: Headers;
  body: unknown;
  keepalive: boolean | undefined;
};

function toCall(input: unknown, init: RequestInit | undefined): Call {
  const href =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : String((input as { url?: unknown }).url);
  let body: unknown = undefined;
  if (typeof init?.body === "string") {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = init.body;
    }
  }
  return {
    url: new URL(href),
    method: (init?.method ?? "GET").toUpperCase(),
    headers: new Headers(init?.headers),
    body,
    keepalive: init?.keepalive,
  };
}

function providerResponse(status: number, body?: unknown): Response {
  const text = body === undefined ? "" : JSON.stringify(body);
  const response = {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: new Headers({ "content-type": "application/json" }),
    json: () =>
      text === "" ? Promise.reject(new SyntaxError("empty body")) : Promise.resolve(JSON.parse(text)),
    text: () => Promise.resolve(text),
    clone: () => providerResponse(status, body),
  };
  return response as unknown as Response;
}

/** Answer every provider request with one status and body, recording what was sent. */
function serve(status: number, body?: unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: unknown, init?: RequestInit) => {
      calls.push(toCall(input, init));
      return Promise.resolve(providerResponse(status, body));
    }),
  );
  return calls;
}

function unreachable(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: unknown, init?: RequestInit) => {
      calls.push(toCall(input, init));
      return Promise.reject(new TypeError("Failed to fetch"));
    }),
  );
  return calls;
}

async function refusal(promise: Promise<unknown>): Promise<AuthError> {
  const caught = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(caught, "the call refuses").toBeInstanceOf(AuthError);
  return caught as AuthError;
}

/** Refresh tokens are single-flight by value, so each call gets its own. */
let refreshCounter = 0;
function freshRefreshToken(): string {
  refreshCounter += 1;
  return `refresh-${String(refreshCounter)}`;
}

const CALL: Record<AuthEndpoint, () => Promise<unknown>> = {
  signIn: () => signIn(EMAIL, PASSWORD),
  signUp: () => signUp(EMAIL, PASSWORD),
  resend: () => resendConfirmation(EMAIL),
  recover: () => requestPasswordReset(EMAIL),
  updatePassword: () => updatePassword(ACCESS, PASSWORD),
  refresh: () => refreshSession(freshRefreshToken()),
};

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", URL_);
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", KEY);
  window.localStorage.clear();
  window.history.replaceState(null, "", "/login");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------
// the classification table, one test per cell
// ---------------------------------------------------------------------------------------------

type Outcome = AuthFailure | "neutral";
type Row = {
  answer: string;
  status: number;
  body: unknown;
  outcomes: Partial<Record<AuthEndpoint, Outcome>>;
};

const RATE_LIMITED_OTHER = {
  signIn: "rateLimited",
  signUp: "rateLimited",
  resend: "neutral",
  recover: "neutral",
  updatePassword: "rateLimited",
  refresh: "rateLimited",
} as const;

// R192: the two mailers answer every provider answer the same way (bar an invalid address and an
// unreachable provider), because only a KNOWN address can reach the provider's mailer and fail
// there: a 500 or an allow-list refusal would say the address has an account.
const SERVICE = {
  signIn: "service",
  signUp: "service",
  resend: "neutral",
  recover: "neutral",
  updatePassword: "service",
  refresh: "service",
} as const;

const DISABLED = {
  signIn: "credentials",
  signUp: "signupsClosed",
  resend: "neutral",
  recover: "neutral",
} as const;

const TOKEN_REFUSED = {
  signIn: "credentials",
  signUp: "signUpRefused",
  resend: "neutral",
  recover: "neutral",
  updatePassword: "linkExpired",
  refresh: "sessionEnded",
} as const;

const OTHER_4XX = {
  signIn: "credentials",
  signUp: "signUpRefused",
  resend: "neutral",
  recover: "neutral",
  updatePassword: "service",
  refresh: "sessionEnded",
} as const;

const ROWS: readonly Row[] = [
  {
    answer: "429 over_email_send_rate_limit",
    status: 429,
    body: { error_code: "over_email_send_rate_limit", msg: PROVIDER_TEXT[0] },
    outcomes: {
      signIn: "rateLimited",
      signUp: "emailRateLimited",
      resend: "neutral",
      recover: "neutral",
      updatePassword: "rateLimited",
      refresh: "rateLimited",
    },
  },
  {
    answer: "429 over_request_rate_limit",
    status: 429,
    body: { error_code: "over_request_rate_limit" },
    outcomes: RATE_LIMITED_OTHER,
  },
  { answer: "429 with no body", status: 429, body: undefined, outcomes: RATE_LIMITED_OTHER },
  { answer: "500", status: 500, body: { error_code: "unexpected_failure" }, outcomes: SERVICE },
  { answer: "502 with no body", status: 502, body: undefined, outcomes: SERVICE },
  { answer: "503", status: 503, body: {}, outcomes: SERVICE },
  {
    answer: "weak_password",
    status: 422,
    body: { error_code: "weak_password", msg: PROVIDER_TEXT[0] },
    outcomes: { signIn: "credentials", signUp: "weakPassword", updatePassword: "weakPassword" },
  },
  ...(
    [
      ["length", "weakPasswordLength"],
      ["characters", "weakPasswordCharacters"],
      ["pwned", "weakPasswordPwned"],
    ] as const
  ).map(([reason, failure]) => ({
    answer: `weak_password for "${reason}"`,
    status: 422,
    body: { error_code: "weak_password", weak_password: { reasons: [reason] }, msg: PROVIDER_TEXT[0] },
    outcomes: { signIn: "credentials" as const, signUp: failure, updatePassword: failure },
  })),
  {
    answer: "email_address_not_authorized (the built-in mailer's allow-list)",
    status: 400,
    body: { error_code: "email_address_not_authorized" },
    outcomes: { resend: "neutral", recover: "neutral" },
  },
  {
    answer: "same_password",
    status: 422,
    body: { error_code: "same_password" },
    outcomes: { signIn: "credentials", signUp: "signUpRefused", updatePassword: "samePassword" },
  },
  {
    answer: "email_address_invalid",
    status: 400,
    body: { error_code: "email_address_invalid" },
    outcomes: {
      signIn: "credentials",
      signUp: "invalidEmail",
      resend: "invalidEmail",
      recover: "invalidEmail",
    },
  },
  { answer: "signup_disabled", status: 422, body: { error_code: "signup_disabled" }, outcomes: DISABLED },
  {
    answer: "email_provider_disabled",
    status: 422,
    body: { error_code: "email_provider_disabled" },
    outcomes: DISABLED,
  },
  { answer: "401", status: 401, body: {}, outcomes: TOKEN_REFUSED },
  { answer: "403", status: 403, body: {}, outcomes: TOKEN_REFUSED },
  ...(
    [
      "bad_jwt",
      "session_expired",
      "session_not_found",
      "refresh_token_not_found",
      "refresh_token_already_used",
    ] as const
  ).map((code) => ({
    answer: code,
    status: 400,
    body: { error_code: code },
    outcomes: TOKEN_REFUSED,
  })),
  {
    answer: "invalid_grant (OAuth-style error field)",
    status: 400,
    body: { error: "invalid_grant", error_description: PROVIDER_TEXT[1] },
    outcomes: TOKEN_REFUSED,
  },
  {
    answer: "email_not_confirmed",
    status: 400,
    body: { error_code: "email_not_confirmed", msg: "Email not confirmed" },
    outcomes: OTHER_4XX,
  },
  {
    answer: "invalid_credentials",
    status: 400,
    body: { error_code: "invalid_credentials", msg: "Invalid login credentials" },
    outcomes: OTHER_4XX,
  },
  { answer: "404", status: 404, body: {}, outcomes: OTHER_4XX },
  {
    // A password past the provider's byte limit (a long passphrase outside ASCII is the likely
    // one): a sentence about the password, not "the service had a problem", which a retry can
    // never get past.
    answer: "422 validation_failed",
    status: 422,
    body: { error_code: "validation_failed", msg: PROVIDER_TEXT[0] },
    outcomes: { ...OTHER_4XX, signUp: "signUpInvalid", updatePassword: "passwordTooLong" },
  },
  {
    answer: "400 validation_failed in the newer shape",
    status: 400,
    body: { code: 400, error_code: "validation_failed", msg: "Password cannot be longer than 72 characters" },
    outcomes: { signIn: "credentials", signUp: "signUpInvalid", updatePassword: "passwordTooLong" },
  },
];

type Cell = Row & { endpoint: AuthEndpoint; outcome: Outcome };

const CELLS: readonly Cell[] = ROWS.flatMap((row) =>
  (Object.entries(row.outcomes) as [AuthEndpoint, Outcome][]).map(([endpoint, outcome]) => ({
    ...row,
    endpoint,
    outcome,
  })),
);

function cellName(cell: Cell): string {
  const ruling = cell.status === 429 ? "R192 " : cell.endpoint === "refresh" ? "R194 " : "";
  return `${ruling}B25 ${cell.answer} at ${cell.endpoint} -> ${cell.outcome}`;
}

describe("B25 every provider answer maps to one failure", () => {
  it.each(CELLS.map((cell) => [cellName(cell), cell] as const))("%s", async (_name, cell) => {
    serve(cell.status, cell.body);
    const call = CALL[cell.endpoint]();

    if (cell.outcome === "neutral") {
      await expect(call).resolves.toBeUndefined();
      return;
    }
    expect(classifyProviderRefusal(cell.endpoint, cell.status, cell.body)).toBe(cell.outcome);
    const error = await refusal(call);
    expect(error.failure).toBe(cell.outcome);
    expect(error.message).toBe(AUTH_MESSAGES[cell.outcome]);
  });

  it.each(Object.keys(CALL).map((endpoint) => [endpoint as AuthEndpoint] as const))(
    "B25 a fetch that rejects at %s is a network failure",
    async (endpoint) => {
      unreachable();
      const error = await refusal(CALL[endpoint]());
      expect(error.failure).toBe("network");
      expect(error.message).toBe(AUTH_MESSAGES.network);
    },
  );

  it("B25 the error code is error_code, else a string code, else error", () => {
    expect(
      classifyProviderRefusal("updatePassword", 422, {
        error_code: "weak_password",
        code: "same_password",
        error: "same_password",
      }),
    ).toBe("weakPassword");
    expect(
      classifyProviderRefusal("updatePassword", 422, { code: "same_password", error: "weak_password" }),
    ).toBe("samePassword");
    // GoTrue's newer shape carries a numeric `code` (the status); it is not an error code.
    expect(classifyProviderRefusal("updatePassword", 422, { code: 422, error: "weak_password" })).toBe(
      "weakPassword",
    );
  });

  it("B25 a body that is not an object reads as the endpoint's generic refusal", () => {
    expect(classifyProviderRefusal("signUp", 400, null)).toBe("signUpRefused");
    expect(classifyProviderRefusal("signUp", 400, "weak_password")).toBe("signUpRefused");
    expect(classifyProviderRefusal("refresh", 400, undefined)).toBe("sessionEnded");
  });
});

// ---------------------------------------------------------------------------------------------
// B25: messages are the client's own
// ---------------------------------------------------------------------------------------------

describe("B25 messages", () => {
  it("B25 AuthError carries its failure and AUTH_MESSAGES' sentence for it", () => {
    const failures: readonly AuthFailure[] = [
      "credentials",
      "signUpRefused",
      "rateLimited",
      "emailRateLimited",
      "weakPassword",
      "weakPasswordLength",
      "weakPasswordCharacters",
      "weakPasswordPwned",
      "samePassword",
      "passwordTooLong",
      "signUpInvalid",
      "invalidEmail",
      "signupsClosed",
      "linkExpired",
      "sessionEnded",
      "network",
      "service",
      "unconfigured",
    ];
    for (const failure of failures) {
      const error = new AuthError(failure);
      expect(error).toBeInstanceOf(Error);
      expect(error.failure).toBe(failure);
      expect(error.message).toBe(AUTH_MESSAGES[failure]);
      expect(AUTH_MESSAGES[failure].length, `${failure} has a sentence`).toBeGreaterThan(0);
    }
  });

  it("B25 the R160 sentences are the credentials and signUpRefused entries", () => {
    expect(SIGN_IN_FAILED_MESSAGE).toBe(AUTH_MESSAGES.credentials);
    expect(SIGN_UP_FAILED_MESSAGE).toBe(AUTH_MESSAGES.signUpRefused);
    expect(AUTH_UNCONFIGURED_MESSAGE).toBe(AUTH_MESSAGES.unconfigured);
  });

  it("B25 no weak-password sentence states a length: the provider's minimum can be raised past config's", () => {
    for (const failure of ["weakPassword", "weakPasswordLength", "weakPasswordCharacters", "weakPasswordPwned"] as const) {
      expect(AUTH_MESSAGES[failure], failure).not.toMatch(/\d/);
    }
    expect(new Set([AUTH_MESSAGES.weakPasswordLength, AUTH_MESSAGES.weakPasswordCharacters, AUTH_MESSAGES.weakPasswordPwned]).size).toBe(3);
  });

  it("B25 several weak_password reasons read as the first of length, characters, pwned", () => {
    const body = (reasons: string[]): unknown => ({ error_code: "weak_password", weak_password: { reasons } });
    expect(classifyProviderRefusal("signUp", 422, body(["pwned", "length"]))).toBe("weakPasswordLength");
    expect(classifyProviderRefusal("signUp", 422, body(["pwned", "characters"]))).toBe("weakPasswordCharacters");
    expect(classifyProviderRefusal("signUp", 422, body(["something-new"]))).toBe("weakPassword");
    expect(classifyProviderRefusal("signUp", 422, { error_code: "weak_password", weak_password: "pwned" })).toBe(
      "weakPassword",
    );
  });

  it("B25 a password refused for several reasons names every one in a single sentence set, so one fix is enough", async () => {
    serve(422, { error_code: "weak_password", weak_password: { reasons: ["characters", "length", "pwned"] } });
    const error = await refusal(signUp(EMAIL, PASSWORD));
    expect(error.failure).toBe("weakPasswordLength");
    expect(error.message.startsWith(AUTH_MESSAGES.weakPasswordLength)).toBe(true);
    expect(error.message).toMatch(/more kinds of characters/);
    expect(error.message).toMatch(/data breach/);
    expect(error.message).not.toMatch(/\d|for this server/);

    // One reason reads exactly its own sentence; sign-in's refusal is never widened.
    serve(422, { error_code: "weak_password", weak_password: { reasons: ["pwned"] } });
    expect((await refusal(signUp(EMAIL, PASSWORD))).message).toBe(AUTH_MESSAGES.weakPasswordPwned);
    serve(422, { error_code: "weak_password", weak_password: { reasons: ["length", "characters"] } });
    expect((await refusal(signIn(EMAIL, PASSWORD))).message).toBe(SIGN_IN_FAILED_MESSAGE);
  });

  it("B25 wrong password, unknown account and unconfirmed email all read SIGN_IN_FAILED_MESSAGE (R160)", async () => {
    const bodies = [
      { error: "invalid_grant", error_description: "Invalid login credentials" },
      { error_code: "invalid_credentials", msg: "Invalid login credentials" },
      { error_code: "email_not_confirmed", msg: "Email not confirmed" },
    ];
    const messages: string[] = [];
    for (const body of bodies) {
      serve(400, body);
      const error = await refusal(signIn(EMAIL, PASSWORD));
      expect(error.failure).toBe("credentials");
      messages.push(error.message);
    }
    expect(new Set(messages)).toEqual(new Set([SIGN_IN_FAILED_MESSAGE]));
  });

  it("B25 provider msg, error_description and message never reach the error", async () => {
    const body = {
      error_code: "weak_password",
      msg: PROVIDER_TEXT[0],
      error_description: PROVIDER_TEXT[1],
      message: PROVIDER_TEXT[2],
    };
    for (const call of [() => signIn(EMAIL, PASSWORD), () => signUp(EMAIL, PASSWORD), () => updatePassword(ACCESS, PASSWORD)]) {
      serve(422, body);
      const error = await refusal(call());
      for (const text of PROVIDER_TEXT) expect(error.message).not.toContain(text);
    }
  });

  it("B25 an unconfigured build refuses sign-in and sign-up with the unconfigured sentence", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "");
    const calls = serve(200, TOKEN_BODY);
    for (const call of [() => signIn(EMAIL, PASSWORD), () => signUp(EMAIL, PASSWORD)]) {
      const error = await refusal(call());
      expect(error.failure).toBe("unconfigured");
      expect(error.message).toBe(AUTH_UNCONFIGURED_MESSAGE);
    }
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// B26 / R192: a rate limit is a rate limit
// ---------------------------------------------------------------------------------------------

describe("R192 B26 rate limits", () => {
  it("R192 a 429 at sign-in reads rateLimited, never the credentials sentence", async () => {
    serve(429, { error_code: "over_request_rate_limit" });
    const error = await refusal(signIn(EMAIL, PASSWORD));
    expect(error.failure).toBe("rateLimited");
    expect(error.message).toBe(AUTH_MESSAGES.rateLimited);
    expect(error.message).not.toBe(SIGN_IN_FAILED_MESSAGE);
  });

  it("R192 a 429 email-send limit at sign-up reads emailRateLimited, never the sign-up sentence", async () => {
    serve(429, { error_code: "over_email_send_rate_limit" });
    const error = await refusal(signUp(EMAIL, PASSWORD));
    expect(error.failure).toBe("emailRateLimited");
    expect(error.message).toBe(AUTH_MESSAGES.emailRateLimited);
    expect(error.message).not.toBe(SIGN_UP_FAILED_MESSAGE);
  });

  it("R192 any other 429 at sign-up reads rateLimited", async () => {
    serve(429, {});
    const error = await refusal(signUp(EMAIL, PASSWORD));
    expect(error.failure).toBe("rateLimited");
    expect(error.message).not.toBe(SIGN_UP_FAILED_MESSAGE);
  });

  it("R192 the rate-limit sentences are distinct from R160's", () => {
    for (const limited of [AUTH_MESSAGES.rateLimited, AUTH_MESSAGES.emailRateLimited]) {
      expect(limited).not.toBe(SIGN_IN_FAILED_MESSAGE);
      expect(limited).not.toBe(SIGN_UP_FAILED_MESSAGE);
    }
  });

  it("R192 resend and recover answer a 2xx and a 429 the same way: they resolve", async () => {
    for (const status of [200, 429]) {
      serve(status, status === 429 ? { error_code: "over_email_send_rate_limit" } : {});
      await expect(resendConfirmation(EMAIL)).resolves.toBeUndefined();
      serve(status, status === 429 ? { error_code: "over_email_send_rate_limit" } : {});
      await expect(requestPasswordReset(EMAIL)).resolves.toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// B27, B28, B31: what each request sends
// ---------------------------------------------------------------------------------------------

describe("the requests", () => {
  function expectPublishableHeaders(call: Call): void {
    expect(call.headers.get("apikey")).toBe(KEY);
  }

  it("R192 B27 resendConfirmation posts type signup and redirects to <origin>/login", async () => {
    const calls = serve(200, {});
    await resendConfirmation(EMAIL);

    expect(calls).toHaveLength(1);
    const call = calls[0] as Call;
    expect(call.method).toBe("POST");
    expect(`${call.url.origin}${call.url.pathname}`).toBe(`${URL_}/auth/v1/resend`);
    expect(call.url.searchParams.get("redirect_to")).toBe(`${window.location.origin}/login`);
    expect(call.body).toEqual({ type: "signup", email: EMAIL, ...PKCE_FIELDS });
    expectPublishableHeaders(call);
    expect(call.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("B28 requestPasswordReset posts the address to recover and redirects to <origin>/login", async () => {
    const calls = serve(200, {});
    await requestPasswordReset(EMAIL);

    expect(calls).toHaveLength(1);
    const call = calls[0] as Call;
    expect(call.method).toBe("POST");
    expect(`${call.url.origin}${call.url.pathname}`).toBe(`${URL_}/auth/v1/recover`);
    expect(call.url.searchParams.get("redirect_to")).toBe(`${window.location.origin}/login`);
    expect(call.body).toEqual({ email: EMAIL, ...PKCE_FIELDS });
    expectPublishableHeaders(call);
    expect(call.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("B31 updatePassword puts the password with the recovery session's bearer token", async () => {
    const calls = serve(200, { id: "user-1", email: EMAIL });
    await expect(updatePassword(ACCESS, PASSWORD)).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    const call = calls[0] as Call;
    expect(call.method).toBe("PUT");
    expect(`${call.url.origin}${call.url.pathname}`).toBe(`${URL_}/auth/v1/user`);
    expect(call.body).toEqual({ password: PASSWORD });
    expectPublishableHeaders(call);
    expect(call.headers.get("authorization")).toBe(`Bearer ${ACCESS}`);
  });

  it("B35 the redirect is always <origin>/login, whatever the address bar carries", async () => {
    window.history.replaceState(
      null,
      "",
      "/login?next=https://evil.example/&redirect_to=https://evil.example/#redirect_to=https://evil.example/",
    );
    expect(authRedirectUrl()).toBe(`${window.location.origin}/login`);

    const calls = serve(200, {});
    await resendConfirmation(EMAIL);
    await requestPasswordReset(EMAIL);
    await signUp(EMAIL, PASSWORD);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.url.searchParams.get("redirect_to")).toBe(`${window.location.origin}/login`);
      expect(call.url.href).not.toContain("evil.example");
    }
  });

  it("B27 authRedirectUrl is <origin>/login", () => {
    expect(authRedirectUrl()).toBe(`${window.location.origin}/login`);
  });
});

// ---------------------------------------------------------------------------------------------
// B32 / R194: renewal
// ---------------------------------------------------------------------------------------------

describe("R194 B32 refreshSession", () => {
  it("R194 posts the refresh grant and returns the new session in epoch ms", async () => {
    const calls = serve(200, TOKEN_BODY);
    const token = freshRefreshToken();
    const before = Date.now();
    const session = await refreshSession(token);

    // `expires_in` from now, on this device's clock (see the next test for why not `expires_at`).
    expect(session).toMatchObject({
      accessToken: TOKEN_BODY.access_token,
      refreshToken: TOKEN_BODY.refresh_token,
    });
    expect(session.expiresAt).toBeGreaterThanOrEqual(before + TOKEN_BODY.expires_in * 1000);
    expect(session.expiresAt).toBeLessThanOrEqual(Date.now() + TOKEN_BODY.expires_in * 1000);
    expect(calls).toHaveLength(1);
    const call = calls[0] as Call;
    expect(call.method).toBe("POST");
    expect(`${call.url.origin}${call.url.pathname}`).toBe(`${URL_}/auth/v1/token`);
    expect(call.url.searchParams.get("grant_type")).toBe("refresh_token");
    expect(call.body).toEqual({ refresh_token: token });
    expect(call.headers.get("apikey")).toBe(KEY);
  });


  it("R194 counts a session's expiry on this device's clock, so a fast clock does not read it as expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // The provider's clock says 12:00; this device's runs 90 minutes fast.
    const providerNow = Date.UTC(2026, 8, 22, 12, 0, 0);
    const deviceNow = providerNow + 90 * 60_000;
    vi.setSystemTime(deviceNow);
    serve(200, { ...TOKEN_BODY, expires_at: Math.floor(providerNow / 1000) + 3600, expires_in: 3600 });
    try {
      const session = await refreshSession(freshRefreshToken());
      expect(session.expiresAt).toBe(deviceNow + 3600 * 1000);
      expect(sessionNearExpiry(session, Date.now())).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("R194 falls back to expires_at, in seconds, only when a response has no expires_in", async () => {
    const { expires_in: _unused, ...withoutExpiresIn } = TOKEN_BODY;
    serve(200, withoutExpiresIn);
    const session = await refreshSession(freshRefreshToken());
    expect(session.expiresAt).toBe(EXPIRES_AT_S * 1000);
  });
  it("R194 concurrent calls with one refresh token share one request", async () => {
    const releases: ((response: Response) => void)[] = [];
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(resolve);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const token = freshRefreshToken();

    const first = refreshSession(token);
    const second = refreshSession(token);
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    for (const release of releases) release(providerResponse(200, TOKEN_BODY));
    const [a, b] = await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(a.accessToken).toBe(TOKEN_BODY.access_token);
  });

  it("R194 the shared request is forgotten once it settles", async () => {
    const calls = serve(200, TOKEN_BODY);
    const token = freshRefreshToken();
    await refreshSession(token);
    await refreshSession(token);
    expect(calls).toHaveLength(2);
  });

  it("R194 a refused renewal is forgotten too, so the next call asks again", async () => {
    const token = freshRefreshToken();
    serve(400, { error_code: "refresh_token_not_found" });
    const error = await refusal(refreshSession(token));
    expect(error.failure).toBe("sessionEnded");

    const calls = serve(200, TOKEN_BODY);
    await expect(refreshSession(token)).resolves.toMatchObject({ accessToken: TOKEN_BODY.access_token });
    expect(calls).toHaveLength(1);
  });

  it("R194 different refresh tokens are not merged", async () => {
    const calls = serve(200, TOKEN_BODY);
    await Promise.all([refreshSession(freshRefreshToken()), refreshSession(freshRefreshToken())]);
    expect(calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------
// B34 / R194: sign-out revokes without waiting
// ---------------------------------------------------------------------------------------------

describe("R194 B34 revokeSession and signOut", () => {
  it("R194 revokeSession posts logout?scope=local with the access token and keepalive", async () => {
    const calls = serve(204);
    await expect(revokeSession(ACCESS)).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    const call = calls[0] as Call;
    expect(call.method).toBe("POST");
    expect(`${call.url.origin}${call.url.pathname}`).toBe(`${URL_}/auth/v1/logout`);
    expect(call.url.searchParams.get("scope")).toBe("local");
    expect(call.keepalive).toBe(true);
    expect(call.headers.get("authorization")).toBe(`Bearer ${ACCESS}`);
    expect(call.headers.get("apikey")).toBe(KEY);
  });

  it("R194 revokeSession resolves when the provider is unreachable", async () => {
    unreachable();
    await expect(revokeSession(ACCESS)).resolves.toBeUndefined();
  });

  it.each([[401], [429], [500]] as const)("R194 revokeSession resolves on a %i", async (status) => {
    serve(status, { error_code: "session_not_found" });
    await expect(revokeSession(ACCESS)).resolves.toBeUndefined();
  });

  it("R194 revokeSession resolves in a build with no provider configured", async () => {
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "");
    serve(200, {});
    await expect(revokeSession(ACCESS)).resolves.toBeUndefined();
  });

  it("R194 B34 signOut clears both keys at once and revokes without waiting for the provider", async () => {
    window.localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ accessToken: ACCESS, refreshToken: "refresh-signed-in", expiresAt: EXPIRES_AT_S * 1000 }),
    );
    window.localStorage.setItem(E2E_SESSION_STORAGE_KEY, JSON.stringify({ accessToken: "e2e-token" }));
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown, init?: RequestInit) => {
        calls.push(toCall(input, init));
        // The provider never answers: signOut must not be waiting on it.
        return new Promise<Response>(() => {});
      }),
    );

    const result: unknown = signOut();

    expect(result, "signOut returns nothing to await").toBeUndefined();
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(E2E_SESSION_STORAGE_KEY)).toBeNull();

    await vi.waitFor(() => {
      expect(calls.some((call) => call.url.pathname === "/auth/v1/logout")).toBe(true);
    });
    const logout = calls.find((call) => call.url.pathname === "/auth/v1/logout") as Call;
    expect(logout.url.searchParams.get("scope")).toBe("local");
    expect(logout.keepalive).toBe(true);
    expect(logout.headers.get("authorization")).toBe(`Bearer ${ACCESS}`);
  });
});

// ---------------------------------------------------------------------------------------------
// B34 / R194: sign-out then loads `/`. It is a real page load (`window.location.assign`), which
// jsdom cannot follow, so `location` is swapped for a copy whose `assign` records the destination,
// what storage held and whether the revoke had been sent when the load began.
// ---------------------------------------------------------------------------------------------

describe("R194 B34 signOut loads the landing page", () => {
  it("R194 B34 loads / after clearing both keys and firing the revoke, without waiting for it", () => {
    window.localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ accessToken: ACCESS, refreshToken: "refresh-signed-in", expiresAt: EXPIRES_AT_S * 1000 }),
    );
    window.localStorage.setItem(E2E_SESSION_STORAGE_KEY, JSON.stringify({ accessToken: "e2e-token" }));
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown, init?: RequestInit) => {
        calls.push(toCall(input, init));
        return new Promise<Response>(() => {});
      }),
    );
    const loads: { to: string; session: string | null; e2eSession: string | null; revokeSent: boolean }[] = [];
    const assign = vi.fn((to: string | URL) => {
      loads.push({
        to: String(to),
        session: window.localStorage.getItem(SESSION_STORAGE_KEY),
        e2eSession: window.localStorage.getItem(E2E_SESSION_STORAGE_KEY),
        revokeSent: calls.some((call) => call.url.pathname === "/auth/v1/logout"),
      });
    });
    vi.stubGlobal("location", { ...window.location, assign });

    signOut();

    // Synchronously: the load has begun while the provider has not answered (and never will).
    expect(loads).toEqual([{ to: paths.landing, session: null, e2eSession: null, revokeSent: true }]);
  });

  it("R193 sign-out forgets the addresses this browser was waiting on, so they arm no later link", () => {
    rememberPendingEmail(EMAIL);
    rememberPendingReset(EMAIL);
    serve(204);
    vi.stubGlobal("location", { ...window.location, assign: vi.fn() });

    signOut();

    expect(pendingEmail()).toBeNull();
    expect(pendingReset()).toBeNull();
  });

  it("R194 B34 a device with no session still loads /, and revokes nothing", () => {
    const calls = serve(204);
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });

    signOut();

    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(paths.landing);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// R194: an expired session is renewed so it can be revoked (the adversarial panel's finding)
// ---------------------------------------------------------------------------------------------

describe("R194 signing out a session whose access token has expired", () => {
  /** GoTrue's /logout: an expired JWT is refused (bad_jwt) and revokes nothing. */
  function provider(): Call[] {
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown, init?: RequestInit) => {
        const call = toCall(input, init);
        calls.push(call);
        if (call.url.pathname === "/auth/v1/logout") {
          const fresh = call.headers.get("authorization") === "Bearer access-new";
          return Promise.resolve(fresh ? providerResponse(204) : providerResponse(401, { error_code: "bad_jwt" }));
        }
        if (call.url.searchParams.get("grant_type") === "refresh_token") {
          return Promise.resolve(providerResponse(200, TOKEN_BODY));
        }
        return Promise.resolve(providerResponse(404, {}));
      }),
    );
    return calls;
  }

  function logouts(calls: Call[]): Call[] {
    return calls.filter((call) => call.url.pathname === "/auth/v1/logout");
  }

  it("R194 renews first, then revokes with a token the provider still accepts", async () => {
    const calls = provider();
    const expired = { accessToken: "expired", refreshToken: "live-refresh", expiresAt: Date.now() - 5 * 60_000 };

    await revokeSignedOutSession(expired);

    const refresh = calls.find((call) => call.url.searchParams.get("grant_type") === "refresh_token");
    expect(refresh?.body).toEqual({ refresh_token: "live-refresh" });
    expect(logouts(calls).map((call) => call.headers.get("authorization"))).toEqual(["Bearer access-new"]);
    expect(logouts(calls)[0]?.keepalive).toBe(true);
  });

  it("R194 a live-looking token the provider refuses is renewed and revoked once more", async () => {
    const calls = provider();

    await revokeSignedOutSession({ accessToken: "revoked-elsewhere", refreshToken: "live-refresh", expiresAt: null });

    expect(logouts(calls).map((call) => call.headers.get("authorization"))).toEqual([
      "Bearer revoked-elsewhere",
      "Bearer access-new",
    ]);
  });

  it("R194 a session with no refresh token is revoked as it is, once", async () => {
    const calls = provider();
    await revokeSignedOutSession({ accessToken: "fixture-token" });
    expect(logouts(calls)).toHaveLength(1);
    expect(calls.some((call) => call.url.searchParams.get("grant_type") === "refresh_token")).toBe(false);
  });

  it("R194 signOut waits for the renewal and the revocation before it loads /, and clears the device first", async () => {
    const calls = provider();
    window.localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ accessToken: "expired", refreshToken: "live-refresh", expiresAt: Date.now() - 5 * 60_000 }),
    );
    const loads: { to: string; revoked: boolean; session: string | null }[] = [];
    const assign = vi.fn((to: string | URL) => {
      loads.push({
        to: String(to),
        revoked: logouts(calls).some((call) => call.headers.get("authorization") === "Bearer access-new"),
        session: window.localStorage.getItem(SESSION_STORAGE_KEY),
      });
    });
    vi.stubGlobal("location", { ...window.location, assign });

    signOut();
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY), "the device is cleared at once").toBeNull();

    await vi.waitFor(() => {
      expect(loads).toEqual([{ to: paths.landing, revoked: true, session: null }]);
    });
  });

  it("R194 signOut loads / anyway once AUTH_SIGN_OUT_WAIT_SECONDS pass without an answer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    window.localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ accessToken: "expired", refreshToken: "stalled-refresh", expiresAt: Date.now() - 60_000 }),
    );
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });

    signOut();
    expect(assign).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(AUTH_SIGN_OUT_WAIT_SECONDS * 1000);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(paths.landing);
  });

  it("R194 a second press while the renewal is out joins the first: no early page load, and the revocation still goes out", async () => {
    let releaseRefresh: (response: Response) => void = () => undefined;
    const logoutCalls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown, init?: RequestInit) => {
        const call = toCall(input, init);
        if (call.url.searchParams.get("grant_type") === "refresh_token") {
          // A slow mobile network: the renewal is still out when the player presses again.
          return new Promise<Response>((resolve) => {
            releaseRefresh = resolve;
          });
        }
        if (call.url.pathname === "/auth/v1/logout") {
          logoutCalls.push(call);
          return Promise.resolve(providerResponse(204));
        }
        return Promise.resolve(providerResponse(404, {}));
      }),
    );
    window.localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ accessToken: "expired", refreshToken: "rt-1", expiresAt: Date.now() - 60_000 }),
    );
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });

    signOut();
    await Promise.resolve();
    // Nothing seemed to happen (the renewal is out), so the player presses again.
    signOut();
    expect(assign, "the second press did not cut the renewal off with a page load").not.toHaveBeenCalled();

    releaseRefresh(providerResponse(200, TOKEN_BODY));
    await vi.waitFor(() => {
      expect(assign).toHaveBeenCalledTimes(1);
    });
    expect(logoutCalls.map((call) => call.headers.get("authorization"))).toEqual([`Bearer ${TOKEN_BODY.access_token}`]);
  });
});

// ---------------------------------------------------------------------------------------------
// R193: a reset request remembers the address, so only its link is accepted
// ---------------------------------------------------------------------------------------------

describe("R193 requestPasswordReset remembers the address it asked for", () => {
  it("R193 remembers the address on any provider answer", async () => {
    for (const status of [200, 429, 500]) {
      window.localStorage.clear();
      serve(status, status === 200 ? {} : { error_code: "unexpected_failure" });
      await requestPasswordReset(EMAIL);
      expect(pendingReset(), String(status)).toBe(EMAIL);
    }
  });

  it("R193 remembers nothing when the provider could not be reached", async () => {
    unreachable();
    await refusal(requestPasswordReset(EMAIL));
    expect(pendingReset()).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// A provider that never answers gives the button back
// ---------------------------------------------------------------------------------------------

describe("B25 a provider request that never answers", () => {
  it("B25 is a network failure after AUTH_PROVIDER_TIMEOUT_SECONDS, and its request is aborted", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: unknown, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      }),
    );

    const pending = refusal(signIn(EMAIL, PASSWORD));
    await vi.advanceTimersByTimeAsync(AUTH_PROVIDER_TIMEOUT_SECONDS * 1000);
    const error = await pending;

    expect(error.failure).toBe("network");
    expect(signal?.aborted).toBe(true);
  });
});

describe("R323 R324 PKCE: the mailers' challenge and the code's exchange", () => {
  const CODE = "3f9c6c1e-5a6b-4c2d-9e8f-0a1b2c3d4e5f";

  it("R323 sign-up, resend and recover each send an s256 challenge of a verifier kept on this device", async () => {
    const calls = serve(200, {});
    await signUp(EMAIL, PASSWORD);
    await resendConfirmation(EMAIL);
    await requestPasswordReset(EMAIL);
    const [signup, resend, recover] = calls.map((call) => call.body as { code_challenge?: string; code_challenge_method?: string });
    for (const body of [signup, resend, recover]) expect(body?.code_challenge_method).toBe("s256");
    // The resend reuses the sign-up's verifier, so the first email's link still exchanges.
    expect(resend?.code_challenge).toBe(signup?.code_challenge);
    const kept = Object.fromEntries(storedVerifiers().map((entry) => [entry.flow, entry.verifier]));
    expect(await challengeFor(kept.signup ?? "")).toBe(signup?.code_challenge);
    expect(await challengeFor(kept.recovery ?? "")).toBe(recover?.code_challenge);
  });

  it("R324 a browser that cannot hash still mails the link, the implicit flow's way", async () => {
    const calls = serve(200, {});
    vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => bytes, subtle: undefined });
    await requestPasswordReset(EMAIL);
    expect(calls[0]?.body).toEqual({ email: EMAIL });
    expect(storedVerifiers()).toEqual([]);
  });

  it("R323 the code is exchanged at grant_type=pkce with auth_code and code_verifier, and its verifier forgotten", async () => {
    await challengeForRequest("recovery");
    const [kept] = storedVerifiers();
    const calls = serve(200, TOKEN_BODY);
    const exchange = await exchangeAuthCode(CODE);

    expect(exchange).toEqual({
      kind: "session",
      flow: "recovery",
      session: { accessToken: "access-new", refreshToken: "refresh-new", expiresAt: expect.any(Number) as unknown as number },
    });
    const call = calls[0] as Call;
    expect(call.method).toBe("POST");
    expect(`${call.url.origin}${call.url.pathname}`).toBe(`${URL_}/auth/v1/token`);
    expect(call.url.searchParams.get("grant_type")).toBe("pkce");
    expect(call.body).toEqual({ auth_code: CODE, code_verifier: kept?.verifier });
    expect(call.headers.get("apikey")).toBe(KEY);
    expect(storedVerifiers()).toEqual([]);
  });

  it("R324 with no verifier on this device the exchange is 'elsewhere', and nothing is sent", async () => {
    const calls = serve(200, TOKEN_BODY);
    expect(await exchangeAuthCode(CODE)).toEqual({ kind: "elsewhere" });
    expect(calls).toEqual([]);
  });

  it("R324 a verifier that is not the code's is 'elsewhere' once none is left, and is kept for its own link", async () => {
    await challengeForRequest("signup");
    serve(400, { error_code: "bad_code_verifier", msg: PROVIDER_TEXT[0] });
    expect(await exchangeAuthCode(CODE)).toEqual({ kind: "elsewhere" });
    expect(storedVerifiers().map((entry) => entry.flow)).toEqual(["signup"]);
  });

  it("R323 a spent or expired code is 'refused'; a provider that cannot answer throws, keeping the verifier", async () => {
    await challengeForRequest("signup");
    serve(404, { error_code: "flow_state_not_found" });
    expect(await exchangeAuthCode(CODE)).toEqual({ kind: "refused" });
    serve(403, { error_code: "flow_state_expired" });
    expect(await exchangeAuthCode(CODE)).toEqual({ kind: "refused" });
    serve(500, {});
    expect((await refusal(exchangeAuthCode(CODE))).failure).toBe("service");
    unreachable();
    expect((await refusal(exchangeAuthCode(CODE))).failure).toBe("network");
    expect(storedVerifiers()).toHaveLength(1);
  });

  it("R323 a code that is not an auth code's shape is refused without a request", async () => {
    await challengeForRequest("signup");
    const calls = serve(200, TOKEN_BODY);
    expect(await exchangeAuthCode("../../token?x=1")).toEqual({ kind: "refused" });
    expect(calls).toEqual([]);
  });
});
