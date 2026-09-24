// `/login` after polish 5 (docs/polish/5-sign-in.md): validation (B24), refusals in the client's
// own words (B25, B26), confirmation resend with its cooldown (B27), forgot password (B28), emailed
// links (B29, B30, R193), the expired-session notice (B33) and no destination read from a URL (B35).
//
// The provider is a stubbed `fetch`; nothing leaves the process. A link is put in the address bar
// with `history.replaceState` before the screen renders, the way a browser opens it.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUTH_EMAIL_RESEND_COOLDOWN_SECONDS,
  AUTH_PASSWORD_MAX_LENGTH,
  AUTH_PASSWORD_MIN_LENGTH,
  AUTH_PENDING_ADDRESS_TTL_SECONDS,
  GATE_SLOW_NOTICE_SECONDS,
} from "../../../server/src/config.ts";
import { clearConsumedAuthRedirect, recoverySession, releaseRecoverySession } from "../auth/redirect.ts";
import { loginTestid } from "../auth/testids.ts";
import { emailProblem, newPasswordProblem } from "../auth/validation.ts";
import {
  AUTH_MESSAGES,
  AUTH_NOTICES,
  SIGN_IN_FAILED_MESSAGE,
  SIGN_UP_FAILED_MESSAGE,
} from "../net/auth.ts";
import { loginModeOf, paths } from "../net/navigate.ts";
import {
  SESSION_STORAGE_KEY,
  pendingEmail,
  pendingReset,
  readSession,
  rememberPendingEmail,
  rememberPendingReset,
} from "../net/session.ts";
import LoginRoute from "./login.tsx";

const URL_ = "https://project.supabase.co";
const KEY = "sb_publishable_test";
const EMAIL = "player@example.com";
const PASSWORD = "x".repeat(AUTH_PASSWORD_MIN_LENGTH);
const LINK_EXPIRES_AT_S = 2_000_000_000;

/** Provider wording that must never reach the DOM. */
const PROVIDER_DESCRIPTION = "PROVIDER-DESCRIPTION-91c2 Email link is invalid or has expired";
const PROVIDER_MSG = "PROVIDER-MSG-91c2";

// ---------------------------------------------------------------------------------------------
// links: unsigned three-part JWTs with a base64url JSON payload
// ---------------------------------------------------------------------------------------------

function base64url(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function jwt(payload: Record<string, unknown>): string {
  return [
    base64url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
    base64url(JSON.stringify(payload)),
    "unsigned",
  ].join(".");
}

/**
 * Every link's refresh token, and what the provider renews it into. `/login` renews a link as soon
 * as it reads it (R193), so the stubbed provider answers each registered refresh token with a new
 * access token of the same account, and the stubbed server verifies that one as the link's own.
 */
const renewals = new Map<string, { renewed: string; rotated: string }>();
/** A renewed access token -> the link's own, so `server`'s accounts can be keyed on the link's. */
const renewedFrom = new Map<string, string>();
let linkCount = 0;

/** Registers a link's refresh token with the stubbed provider; returns the renewed access token. */
function renewable(token: string, refreshToken: string, payload: Record<string, unknown>): string {
  const renewed = jwt({ ...payload, renewed: refreshToken });
  renewals.set(refreshToken, { renewed, rotated: `${refreshToken}-rotated` });
  renewedFrom.set(renewed, token);
  return renewed;
}

/** The fragment Supabase appends to a confirmation or recovery link. */
function link(type: string, email: string | null): { token: string; hash: string; refresh: string; renewed: string } {
  linkCount += 1;
  const payload = email === null ? { sub: "user-1" } : { sub: "user-1", email };
  const token = jwt({ ...payload, link: linkCount });
  const refresh = `refresh-from-link-${String(linkCount)}`;
  const renewed = renewable(token, refresh, payload);
  const params = new URLSearchParams({
    access_token: token,
    refresh_token: refresh,
    expires_at: String(LINK_EXPIRES_AT_S),
    expires_in: "3600",
    token_type: "bearer",
    type,
  });
  return { token, hash: `#${params.toString()}`, refresh, renewed };
}

/**
 * The session a link leaves once `/login` has renewed it (R193). Its expiry is `expires_in` from
 * when it was renewed, on this device's clock (R194), so any number stands here.
 */
function linkSession(renewedLink: { refresh: string; renewed: string }) {
  return {
    accessToken: renewedLink.renewed,
    refreshToken: `${renewedLink.refresh}-rotated`,
    expiresAt: expect.any(Number) as unknown as number,
  };
}

/** The provider's answer to a refresh grant for a registered link, or null for any other. */
function renewalAnswer(url: URL, body: unknown): Response | null {
  if (url.pathname !== "/auth/v1/token" || url.searchParams.get("grant_type") !== "refresh_token") return null;
  const refreshToken = (body as { refresh_token?: unknown } | undefined)?.refresh_token;
  const entry = typeof refreshToken === "string" ? renewals.get(refreshToken) : undefined;
  if (entry === undefined) return providerResponse(400, { error_code: "refresh_token_not_found" });
  return providerResponse(200, {
    access_token: entry.renewed,
    refresh_token: entry.rotated,
    expires_in: 3600,
    token_type: "bearer",
  });
}

// ---------------------------------------------------------------------------------------------
// the stubbed provider
// ---------------------------------------------------------------------------------------------

type Call = { url: URL; method: string; body: unknown; auth?: string | null };
type Answer = { status: number; body?: unknown };

function providerResponse(status: number, body?: unknown): Response {
  const text = body === undefined ? "" : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: new Headers({ "content-type": "application/json" }),
    json: () =>
      text === "" ? Promise.reject(new SyntaxError("empty body")) : Promise.resolve(JSON.parse(text)),
    text: () => Promise.resolve(text),
    clone: () => providerResponse(status, body),
  } as unknown as Response;
}

/** Answers by pathname (`/auth/v1/token`, `/auth/v1/resend`, …); anything else is a 404. */
function provider(answers: Record<string, Answer>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : String((input as URL).href ?? input));
      let body: unknown = undefined;
      if (typeof init?.body === "string") body = JSON.parse(init.body);
      calls.push({ url, method: (init?.method ?? "GET").toUpperCase(), body });
      const renewal = renewalAnswer(url, body);
      if (renewal !== null) return Promise.resolve(renewal);
      const answer = answers[url.pathname] ?? { status: 404, body: {} };
      return Promise.resolve(providerResponse(answer.status, answer.body));
    }),
  );
  return calls;
}

/**
 * The provider (by pathname, as `provider` answers) plus our server's `GET /api/auth/me`, which
 * verifies a token: it answers 200 with the account's address for a token in `accounts`, and 401
 * for any other, as the real server does for a forged or spent one. `"hang"` never answers.
 */
function server(accounts: Record<string, string | null> | "hang", answers: Record<string, Answer> = {}): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : String((input as URL).href ?? input));
      let body: unknown = undefined;
      if (typeof init?.body === "string") body = JSON.parse(init.body);
      calls.push({
        url,
        method: (init?.method ?? "GET").toUpperCase(),
        body,
        auth: new Headers(init?.headers).get("authorization"),
      });
      const renewal = renewalAnswer(url, body);
      if (renewal !== null) return Promise.resolve(renewal);
      if (url.pathname === "/api/auth/me") {
        if (accounts === "hang") return new Promise<Response>(() => {});
        const presented = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
        // A link's renewal verifies as the link's own account.
        const bearer = renewedFrom.get(presented) ?? presented;
        if (!(bearer in accounts)) {
          return Promise.resolve(providerResponse(401, { error: { code: "unauthorized", message: "sign in first" } }));
        }
        return Promise.resolve(
          providerResponse(200, {
            profile: { id: "profile-1", status: "pending", rating: 1000 },
            needsInviteCode: true,
            emailVerified: true,
            currentMatchId: null,
            email: accounts[bearer] ?? null,
          }),
        );
      }
      const answer = answers[url.pathname] ?? { status: 404, body: {} };
      return Promise.resolve(providerResponse(answer.status, answer.body));
    }),
  );
  return calls;
}

function callsTo(calls: readonly Call[], pathname: string): Call[] {
  return calls.filter((call) => call.url.pathname === pathname);
}

const SIGNED_IN = {
  status: 200,
  body: {
    access_token: "access-signed-in",
    refresh_token: "refresh-signed-in",
    expires_at: LINK_EXPIRES_AT_S,
    expires_in: 3600,
    token_type: "bearer",
    user: { email: EMAIL, email_confirmed_at: "2026-09-20T00:00:00Z" },
  },
} as const;

// ---------------------------------------------------------------------------------------------
// the screen
// ---------------------------------------------------------------------------------------------

function at(url: string): void {
  window.history.replaceState(null, "", url);
}

function form(): HTMLElement {
  return screen.getByTestId(loginTestid.form);
}

function setField(testId: string, value: string): void {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
}

function submitForm(): void {
  fireEvent.submit(form());
}

function toSignUp(): void {
  fireEvent.click(screen.getByTestId(loginTestid.mode));
  expect(form()).toHaveAttribute("data-mode", "signUp");
}

function bodyText(): string {
  return document.body.textContent ?? "";
}

/** Settle promise chains without touching timers (the cooldown runs on fake ones). */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  renewals.clear();
  renewedFrom.clear();
  vi.stubEnv("VITE_SUPABASE_URL", URL_);
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", KEY);
  window.localStorage.clear();
  window.sessionStorage.clear();
  clearConsumedAuthRedirect();
  releaseRecoverySession();
  at("/login");
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  // A link still pending when the screen unmounts is revoked just after the unmount: let that land
  // on this test's stubbed provider, not the next test's.
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  clearConsumedAuthRedirect();
  releaseRecoverySession();
});

// ---------------------------------------------------------------------------------------------
// B24: validation
// ---------------------------------------------------------------------------------------------

describe("B24 validation", () => {
  it("B24 sign-up refuses an invalid email without calling the provider", () => {
    const calls = provider({ "/auth/v1/signup": { status: 200, body: {} } });
    render(<LoginRoute />);
    toSignUp();
    setField(loginTestid.email, "not-an-email");
    setField(loginTestid.password, PASSWORD);
    submitForm();

    expect(calls).toHaveLength(0);
    expect(screen.getByTestId(loginTestid.email)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByTestId(loginTestid.emailError).textContent).toBe(emailProblem("not-an-email"));
  });

  it.each([
    ["one under the minimum", AUTH_PASSWORD_MIN_LENGTH - 1],
    ["one over the maximum", AUTH_PASSWORD_MAX_LENGTH + 1],
    ["empty", 0],
  ] as const)("B24 sign-up refuses a password %s without calling the provider", (_name, length) => {
    const calls = provider({ "/auth/v1/signup": { status: 200, body: {} } });
    render(<LoginRoute />);
    toSignUp();
    const password = "x".repeat(length);
    setField(loginTestid.email, EMAIL);
    setField(loginTestid.password, password);
    submitForm();

    expect(calls).toHaveLength(0);
    expect(screen.getByTestId(loginTestid.password)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByTestId(loginTestid.passwordError).textContent).toBe(newPasswordProblem(password));
  });

  it("B24 sign-up sends a valid email and a password at the bounds", async () => {
    for (const length of [AUTH_PASSWORD_MIN_LENGTH, AUTH_PASSWORD_MAX_LENGTH]) {
      cleanup();
      const calls = provider({ "/auth/v1/signup": { status: 200, body: { id: "user-1" } } });
      render(<LoginRoute />);
      toSignUp();
      setField(loginTestid.email, EMAIL);
      setField(loginTestid.password, "x".repeat(length));
      submitForm();
      await waitFor(() => {
        expect(callsTo(calls, "/auth/v1/signup")).toHaveLength(1);
      });
      expect(callsTo(calls, "/auth/v1/signup")[0]?.body).toEqual({ email: EMAIL, password: "x".repeat(length) });
    }
  });

  it("B24 sign-in with an empty email or an empty password calls nothing", () => {
    const calls = provider({ "/auth/v1/token": SIGNED_IN });
    render(<LoginRoute />);

    setField(loginTestid.email, "");
    setField(loginTestid.password, PASSWORD);
    submitForm();
    expect(calls).toHaveLength(0);

    setField(loginTestid.email, EMAIL);
    setField(loginTestid.password, "");
    submitForm();
    expect(calls).toHaveLength(0);
  });

  it("B24 sign-in trims the email before sending it", async () => {
    const calls = provider({ "/auth/v1/token": SIGNED_IN });
    render(<LoginRoute />);
    setField(loginTestid.email, `  ${EMAIL}\t`);
    setField(loginTestid.password, PASSWORD);
    submitForm();
    await waitFor(() => {
      expect(callsTo(calls, "/auth/v1/token")).toHaveLength(1);
    });
    expect((callsTo(calls, "/auth/v1/token")[0]?.body as { email?: unknown }).email).toBe(EMAIL);
  });

  it("B24 sign-in judges neither format nor length: that is the provider's to refuse", async () => {
    const calls = provider({ "/auth/v1/token": { status: 400, body: { error_code: "invalid_credentials" } } });
    render(<LoginRoute />);
    setField(loginTestid.email, "not-an-email");
    setField(loginTestid.password, "x");
    submitForm();
    await waitFor(() => {
      expect(callsTo(calls, "/auth/v1/token")).toHaveLength(1);
    });
    expect(screen.queryByTestId(loginTestid.emailError)).toBeNull();
    expect(screen.queryByTestId(loginTestid.passwordError)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// B25, B26: refusals, in the client's words
// ---------------------------------------------------------------------------------------------

describe("B25 B26 refusals", () => {
  it("B25 an unconfirmed email reads SIGN_IN_FAILED_MESSAGE and no provider text reaches the page", async () => {
    provider({
      "/auth/v1/token": {
        status: 400,
        body: { error_code: "email_not_confirmed", msg: PROVIDER_MSG, error_description: PROVIDER_DESCRIPTION },
      },
    });
    render(<LoginRoute />);
    setField(loginTestid.email, EMAIL);
    setField(loginTestid.password, PASSWORD);
    submitForm();

    const error = await screen.findByTestId(loginTestid.error);
    expect(error.textContent).toBe(SIGN_IN_FAILED_MESSAGE);
    expect(bodyText()).not.toContain(PROVIDER_MSG);
    expect(bodyText()).not.toContain("PROVIDER-DESCRIPTION");
  });

  it("R192 B26 a 429 at sign-in reads rateLimited, not the credentials sentence", async () => {
    provider({ "/auth/v1/token": { status: 429, body: { error_code: "over_request_rate_limit" } } });
    render(<LoginRoute />);
    setField(loginTestid.email, EMAIL);
    setField(loginTestid.password, PASSWORD);
    submitForm();

    const error = await screen.findByTestId(loginTestid.error);
    expect(error.textContent).toBe(AUTH_MESSAGES.rateLimited);
    expect(error.textContent).not.toBe(SIGN_IN_FAILED_MESSAGE);
  });

  it("R192 B26 a 429 email-send limit at sign-up reads emailRateLimited, not the sign-up sentence", async () => {
    provider({ "/auth/v1/signup": { status: 429, body: { error_code: "over_email_send_rate_limit", msg: PROVIDER_MSG } } });
    render(<LoginRoute />);
    toSignUp();
    setField(loginTestid.email, EMAIL);
    setField(loginTestid.password, PASSWORD);
    submitForm();

    const error = await screen.findByTestId(loginTestid.error);
    expect(error.textContent).toBe(AUTH_MESSAGES.emailRateLimited);
    expect(error.textContent).not.toBe(SIGN_UP_FAILED_MESSAGE);
    expect(bodyText()).not.toContain(PROVIDER_MSG);
  });

  it("B25 a weak password at sign-up reads the weakPassword sentence", async () => {
    provider({ "/auth/v1/signup": { status: 422, body: { error_code: "weak_password", msg: PROVIDER_MSG } } });
    render(<LoginRoute />);
    toSignUp();
    setField(loginTestid.email, EMAIL);
    setField(loginTestid.password, PASSWORD);
    submitForm();

    expect((await screen.findByTestId(loginTestid.error)).textContent).toBe(AUTH_MESSAGES.weakPassword);
    expect(bodyText()).not.toContain(PROVIDER_MSG);
  });
});

// ---------------------------------------------------------------------------------------------
// B27 / R192: resend, and its cooldown
// ---------------------------------------------------------------------------------------------

describe("R192 B27 resend", () => {
  async function signUpAndWaitForResend(calls: () => Call[]): Promise<HTMLElement> {
    render(<LoginRoute />);
    toSignUp();
    setField(loginTestid.email, EMAIL);
    setField(loginTestid.password, PASSWORD);
    submitForm();
    await waitFor(() => {
      expect(callsTo(calls(), "/auth/v1/signup")).toHaveLength(1);
    });
    return screen.findByTestId(loginTestid.resend);
  }

  /** A failed sign-in offers the resend with no interval running (nothing was just mailed). */
  async function failSignInAndWaitForResend(): Promise<HTMLElement> {
    render(<LoginRoute />);
    setField(loginTestid.email, EMAIL);
    setField(loginTestid.password, PASSWORD);
    submitForm();
    await screen.findByTestId(loginTestid.error);
    return screen.findByTestId(loginTestid.resend);
  }

  it("R192 B27 after a sign-up, resend waits out the interval the sign-up started, then posts type signup to <origin>/login", async () => {
    // The sign-up itself mailed the address, which starts the provider's per-address interval: a
    // resend straight away would be refused, and the neutral notice would claim a mail was sent.
    // The interval is counted on the clock, so the clock is faked with the timers.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const calls = provider({
      "/auth/v1/signup": { status: 200, body: { id: "user-1" } },
      "/auth/v1/resend": { status: 200, body: {} },
    });
    const resend = await signUpAndWaitForResend(() => calls);
    expect(bodyText()).toContain(AUTH_NOTICES.signUpSent);
    expect(resend).toBeDisabled();
    expect(screen.getByTestId(loginTestid.resendCooldown)).toHaveAttribute(
      "data-seconds",
      String(AUTH_EMAIL_RESEND_COOLDOWN_SECONDS),
    );
    fireEvent.click(resend);
    await flushMicrotasks();
    expect(callsTo(calls, "/auth/v1/resend")).toHaveLength(0);

    act(() => {
      vi.advanceTimersByTime(AUTH_EMAIL_RESEND_COOLDOWN_SECONDS * 1000);
    });
    const ready = screen.getByTestId(loginTestid.resend);
    expect(ready).toBeEnabled();
    await act(async () => {
      fireEvent.click(ready);
    });
    await flushMicrotasks();

    const sent = callsTo(calls, "/auth/v1/resend");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe("POST");
    expect(sent[0]?.body).toEqual({ type: "signup", email: EMAIL });
    expect(sent[0]?.url.searchParams.get("redirect_to")).toBe(`${window.location.origin}/login`);
    expect(bodyText()).toContain(AUTH_NOTICES.resendSent);

    // And the resend starts the interval again, counted down a second at a time.
    expect(screen.getByTestId(loginTestid.resendCooldown)).toHaveAttribute(
      "data-seconds",
      String(AUTH_EMAIL_RESEND_COOLDOWN_SECONDS),
    );
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId(loginTestid.resendCooldown)).toHaveAttribute(
      "data-seconds",
      String(AUTH_EMAIL_RESEND_COOLDOWN_SECONDS - 1),
    );
    const during = screen.getByTestId(loginTestid.resend);
    fireEvent.click(during);
    await flushMicrotasks();
    expect(callsTo(calls, "/auth/v1/resend")).toHaveLength(1);
  });

  it("R192 B27 the interval belongs to the address: a different address can be sent to at once", async () => {
    const calls = provider({
      "/auth/v1/signup": { status: 200, body: { id: "user-1" } },
      "/auth/v1/resend": { status: 200, body: {} },
    });
    const resend = await signUpAndWaitForResend(() => calls);
    expect(resend).toBeDisabled();

    setField(loginTestid.email, "someone.else@example.com");
    expect(screen.getByTestId(loginTestid.resend)).toBeEnabled();
    expect(screen.queryByTestId(loginTestid.resendCooldown)).toBeNull();

    // Back to the address that was mailed, in another case: the interval is still running.
    setField(loginTestid.email, EMAIL.toUpperCase());
    expect(screen.getByTestId(loginTestid.resend)).toBeDisabled();
  });

  it("R192 B27 a 429 on resend shows the same neutral notice and starts the cooldown", async () => {
    provider({
      "/auth/v1/token": { status: 400, body: { error_code: "invalid_credentials" } },
      "/auth/v1/resend": { status: 429, body: { error_code: "over_email_send_rate_limit", msg: PROVIDER_MSG } },
    });
    const resend = await failSignInAndWaitForResend();
    fireEvent.click(resend);

    await waitFor(() => {
      expect(bodyText()).toContain(AUTH_NOTICES.resendSent);
    });
    expect(screen.queryByTestId(loginTestid.error)).toBeNull();
    expect(screen.getByTestId(loginTestid.resendCooldown)).toHaveAttribute(
      "data-seconds",
      String(AUTH_EMAIL_RESEND_COOLDOWN_SECONDS),
    );
    expect(bodyText()).not.toContain(PROVIDER_MSG);
  });

  it("R192 B27 a provider failure on resend reads the same neutral notice: only a known address can fail there", async () => {
    // GoTrue answers an unknown address 200 without reaching its mailer, so a 500 (the mail could
    // not be sent) or an allow-list refusal would tell the page the address has an account.
    for (const answer of [
      { status: 500, body: { error_code: "unexpected_failure" } },
      { status: 400, body: { error_code: "email_address_not_authorized" } },
    ]) {
      cleanup();
      // Each answer is another browser's: this one's send would still be in its interval.
      window.localStorage.clear();
      provider({
        "/auth/v1/token": { status: 400, body: { error_code: "invalid_credentials" } },
        "/auth/v1/resend": answer,
      });
      const resend = await failSignInAndWaitForResend();
      fireEvent.click(resend);

      await waitFor(() => {
        expect(bodyText()).toContain(AUTH_NOTICES.resendSent);
      });
      expect(bodyText()).not.toContain(AUTH_MESSAGES.service);
    }
  });

  it("B27 a resend that cannot reach the provider says so", async () => {
    render(<LoginRoute />);
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown) =>
        String(input).includes("/auth/v1/resend")
          ? Promise.reject(new TypeError("Failed to fetch"))
          : Promise.resolve(providerResponse(400, { error_code: "invalid_credentials" })),
      ),
    );
    setField(loginTestid.email, EMAIL);
    setField(loginTestid.password, PASSWORD);
    submitForm();
    fireEvent.click(await screen.findByTestId(loginTestid.resend));

    await waitFor(() => {
      expect(screen.getByTestId(loginTestid.error).textContent).toBe(AUTH_MESSAGES.network);
    });
    expect(bodyText()).not.toContain(AUTH_NOTICES.resendSent);
  });

  it("B27 resend is offered after a failed sign-in and posts the typed address", async () => {
    const calls = provider({
      "/auth/v1/token": { status: 400, body: { error_code: "invalid_credentials" } },
      "/auth/v1/resend": { status: 200, body: {} },
    });
    render(<LoginRoute />);
    setField(loginTestid.email, EMAIL);
    setField(loginTestid.password, PASSWORD);
    submitForm();

    expect((await screen.findByTestId(loginTestid.error)).textContent).toBe(SIGN_IN_FAILED_MESSAGE);
    fireEvent.click(await screen.findByTestId(loginTestid.resend));

    await waitFor(() => {
      expect(callsTo(calls, "/auth/v1/resend")).toHaveLength(1);
    });
    expect(callsTo(calls, "/auth/v1/resend")[0]?.body).toEqual({ type: "signup", email: EMAIL });
  });

  it("B29 a sign-up remembers the address its confirmation link will carry", async () => {
    const calls = provider({ "/auth/v1/signup": { status: 200, body: { id: "user-1" } } });
    await signUpAndWaitForResend(() => calls);
    expect(pendingEmail()).toBe(EMAIL);
  });
});

// ---------------------------------------------------------------------------------------------
// B28: forgot password
// ---------------------------------------------------------------------------------------------

describe("B28 forgot password", () => {
  async function requestReset(email: string): Promise<void> {
    fireEvent.click(screen.getByTestId(loginTestid.forgot));
    expect(form()).toHaveAttribute("data-mode", "forgot");
    setField(loginTestid.email, email);
    submitForm();
    await waitFor(() => {
      expect(
        screen.queryByTestId(loginTestid.error) !== null || bodyText().includes(AUTH_NOTICES.resetSent),
      ).toBe(true);
    });
  }

  it("B28 login-forgot switches to a one-field form", () => {
    render(<LoginRoute />);
    fireEvent.click(screen.getByTestId(loginTestid.forgot));
    expect(form()).toHaveAttribute("data-mode", "forgot");
    expect(screen.getByTestId(loginTestid.email)).toBeInTheDocument();
    expect(screen.queryByTestId(loginTestid.password)).toBeNull();
  });

  it("B28 posts recover with <origin>/login and shows resetSent, then offers the way back", async () => {
    const calls = provider({ "/auth/v1/recover": { status: 200, body: {} } });
    render(<LoginRoute />);
    await requestReset(EMAIL);

    const sent = callsTo(calls, "/auth/v1/recover");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe("POST");
    expect(sent[0]?.body).toEqual({ email: EMAIL });
    expect(sent[0]?.url.searchParams.get("redirect_to")).toBe(`${window.location.origin}/login`);
    expect(bodyText()).toContain(AUTH_NOTICES.resetSent);

    fireEvent.click(await screen.findByTestId(loginTestid.backToSignIn));
    expect(form()).toHaveAttribute("data-mode", "signIn");
    expect(screen.getByTestId(loginTestid.password)).toBeInTheDocument();
  });

  it("R192 B28 answers a 2xx and a 429 identically, so the page never says whether an account exists", async () => {
    const texts: string[] = [];
    for (const answer of [
      { status: 200, body: {} },
      { status: 429, body: { error_code: "over_email_send_rate_limit", msg: PROVIDER_MSG } },
    ]) {
      cleanup();
      // Each answer is another browser's: this one's send would still be in its interval.
      window.localStorage.clear();
      provider({ "/auth/v1/recover": answer });
      render(<LoginRoute />);
      await requestReset(EMAIL);
      expect(screen.queryByTestId(loginTestid.error)).toBeNull();
      expect(bodyText()).toContain(AUTH_NOTICES.resetSent);
      expect(bodyText()).not.toContain(PROVIDER_MSG);
      texts.push(bodyText());
    }
    expect(texts[0]).toBe(texts[1]);
  });

  it("R192 B28 a provider failure reads the same neutral notice, so the form is no account oracle", async () => {
    const texts: string[] = [];
    for (const answer of [
      { status: 200, body: {} },
      { status: 500, body: { error_code: "unexpected_failure", msg: PROVIDER_MSG } },
      { status: 400, body: { error_code: "email_address_not_authorized" } },
    ]) {
      cleanup();
      window.localStorage.clear();
      provider({ "/auth/v1/recover": answer });
      render(<LoginRoute />);
      await requestReset(EMAIL);
      expect(screen.queryByTestId(loginTestid.error)).toBeNull();
      expect(bodyText()).toContain(AUTH_NOTICES.resetSent);
      texts.push(bodyText());
    }
    expect(new Set(texts).size).toBe(1);
  });

  it("R192 B28 the reset interval belongs to the address: a corrected address can be sent to at once", async () => {
    const calls = provider({ "/auth/v1/recover": { status: 200, body: {} } });
    render(<LoginRoute />);
    await requestReset("player@exmaple.com");
    expect(screen.getByTestId(loginTestid.submit)).toBeDisabled();

    setField(loginTestid.email, EMAIL);
    const submit = screen.getByTestId(loginTestid.submit);
    expect(submit).toBeEnabled();
    expect(submit.textContent).toBe("Send reset link");
    submitForm();
    await waitFor(() => {
      expect(callsTo(calls, "/auth/v1/recover")).toHaveLength(2);
    });
    expect(callsTo(calls, "/auth/v1/recover")[1]?.body).toEqual({ email: EMAIL });
  });

  it("B28 an address the provider calls invalid reads invalidEmail", async () => {
    provider({ "/auth/v1/recover": { status: 400, body: { error_code: "email_address_invalid" } } });
    render(<LoginRoute />);
    await requestReset("player@example.invalid");
    expect(screen.getByTestId(loginTestid.error).textContent).toBe(AUTH_MESSAGES.invalidEmail);
  });

  it("B28 /login?mode=forgot opens the forgot form directly", () => {
    at("/login?mode=forgot");
    render(<LoginRoute />);
    expect(form()).toHaveAttribute("data-mode", "forgot");
  });

  it("B28 loginModeOf reads exactly forgot, and nothing else", () => {
    expect(loginModeOf("?mode=forgot")).toBe("forgot");
    expect(loginModeOf("?mode=FORGOT")).toBeNull();
    expect(loginModeOf("?mode=signUp")).toBeNull();
    expect(loginModeOf("?mode=forgotten")).toBeNull();
    expect(loginModeOf("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// B29 / R193: confirmation links
// ---------------------------------------------------------------------------------------------

describe("R193 B29 confirmation links", () => {
  it("R193 a signup link for the sign-up this browser started signs nothing in: the player signs in with the password they chose", async () => {
    // Account pre-hijack: someone registered this address first with a password of their own. The
    // provider leaves an existing unconfirmed account's password alone when the address signs up
    // again (it only mails the link again, and answers 200), so the account the player confirms
    // keeps the other person's password. Signing in by hand is what exposes it.
    const calls = server({}, { "/auth/v1/signup": { status: 200, body: { id: "user-1", email: EMAIL } } });
    render(<LoginRoute />);
    toSignUp();
    setField(loginTestid.email, EMAIL);
    setField(loginTestid.password, PASSWORD);
    submitForm();
    await waitFor(() => {
      expect(callsTo(calls, "/auth/v1/signup")).toHaveLength(1);
    });
    await flushMicrotasks();
    expect(pendingEmail()).toBe(EMAIL);
    cleanup();

    // The genuine confirmation link, opened in the same browser.
    const { token, hash, renewed } = link("signup", EMAIL);
    const linkCalls = server({ [token]: EMAIL }, { "/auth/v1/logout": { status: 204 } });
    at(`/login${hash}`);
    render(<LoginRoute />);

    const confirmed = await screen.findByTestId(loginTestid.confirmed);
    expect(confirmed.textContent).toBe(AUTH_NOTICES.emailConfirmed);
    await flushMicrotasks();
    expect(readSession()).toBeNull();
    expect(window.location.pathname).toBe(paths.login);
    expect(screen.getByTestId(loginTestid.password)).toHaveValue("");
    // The link's session is not kept, so it is revoked: its renewal, since the link's own refresh
    // token was spent on arrival (its tokens were in the URL).
    expect(callsTo(linkCalls, "/auth/v1/logout").map((call) => call.auth)).toEqual([`Bearer ${renewed}`]);
    // The sign-up is confirmed: its "open the link first" hint is over.
    expect(pendingEmail()).toBeNull();
    expect(window.location.href).not.toContain(token);
    expect(window.location.href).not.toContain("access_token");
  });

  it("R193 the pending address is compared case-insensitively when the link's sign-up is marked confirmed", async () => {
    rememberPendingEmail("Player@Example.COM");
    const { token, hash } = link("signup", EMAIL);
    server({ [token]: EMAIL });
    at(`/login${hash}`);
    render(<LoginRoute />);
    await screen.findByTestId(loginTestid.confirmed);
    await flushMicrotasks();
    expect(pendingEmail()).toBeNull();
    expect(readSession()).toBeNull();
  });

  it.each([
    ["another address is pending", "someone-else@example.com" as string | null],
    ["no address is pending", null],
  ] as const)(
    "R193 when %s, a signup link stores nothing, fills in nothing, and asks for a sign-in",
    async (_name, pending) => {
      if (pending !== null) rememberPendingEmail(pending);
      const { token, hash } = link("signup", EMAIL);
      server({ [token]: EMAIL });
      at(`/login${hash}`);
      render(<LoginRoute />);

      const confirmed = await screen.findByTestId(loginTestid.confirmed);
      expect(confirmed.textContent).toContain(AUTH_NOTICES.emailConfirmed);
      // The link can be anyone's: its address is never put in a form (see the R193 chain below).
      expect(screen.getByTestId(loginTestid.email)).toHaveValue("");
      expect(readSession()).toBeNull();
      expect(window.location.pathname).toBe(paths.login);
      expect(window.location.href).not.toContain(token);
      expect(window.location.href).not.toContain("access_token");
    },
  );

  it("R193 a link whose account has no email never signs in, even with an address pending", async () => {
    rememberPendingEmail(EMAIL);
    const { token, hash } = link("signup", null);
    server({ [token]: null });
    at(`/login${hash}`);
    render(<LoginRoute />);
    await screen.findByTestId(loginTestid.confirmed);
    expect(readSession()).toBeNull();
    expect(window.location.pathname).toBe(paths.login);
  });

  it("R193 a forged token naming the pending address, beside someone else's real refresh token, signs nothing in", async () => {
    // The victim signed up here. The attacker's link: an unsigned token whose payload names the
    // victim, and the attacker's own refresh token, which renews into the attacker's account.
    rememberPendingEmail(EMAIL);
    const forged = jwt({ sub: "whoever", email: EMAIL });
    const attackerToken = jwt({ sub: "attacker", email: "attacker@evil.example" });
    const attackerRenewed = renewable(attackerToken, "attacker-real-refresh-token", {
      sub: "attacker",
      email: "attacker@evil.example",
    });
    const params = new URLSearchParams({
      access_token: forged,
      refresh_token: "attacker-real-refresh-token",
      expires_in: "3600",
      token_type: "bearer",
      type: "signup",
    });
    // The server verifies each token it is given: the renewal is the attacker's account, whatever
    // the forged token's payload said.
    const calls = server({ [attackerToken]: "attacker@evil.example" }, { "/auth/v1/logout": { status: 204 } });
    at(`/login#${params.toString()}`);
    render(<LoginRoute />);

    await screen.findByTestId(loginTestid.confirmed);
    await flushMicrotasks();
    expect(readSession()).toBeNull();
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(window.location.pathname).toBe(paths.login);
    // Nothing from the link is filled in, the victim's sign-up is still the one waited on, and the
    // attacker's session the link renewed into is revoked.
    expect(screen.getByTestId(loginTestid.email)).toHaveValue("");
    expect(pendingEmail()).toBe(EMAIL);
    expect(callsTo(calls, "/auth/v1/logout").map((call) => call.auth)).toEqual([`Bearer ${attackerRenewed}`]);
  });

  it("R193 a link's unverified address is never filled in or announced as confirmed", async () => {
    // A crafted link naming the attacker's address. Filling it in would let one click on "Forgot
    // your password?" arm this browser to accept the attacker's own reset link.
    const params = new URLSearchParams({
      access_token: jwt({ sub: "x", email: "attacker@evil.example" }),
      refresh_token: "junk",
      type: "signup",
    });
    server({});
    at(`/login#${params.toString()}`);
    render(<LoginRoute />);

    await screen.findByTestId(loginTestid.linkError);
    expect(screen.queryByTestId(loginTestid.confirmed)).toBeNull();
    expect(screen.getByTestId(loginTestid.email)).toHaveValue("");
  });

  it("R193 while the link is being checked nothing is stored, and a server that cannot be reached decides nothing", async () => {
    rememberPendingEmail(EMAIL);
    const { hash } = link("signup", EMAIL);
    server("hang");
    at(`/login${hash}`);
    render(<LoginRoute />);
    expect(screen.getByTestId(loginTestid.checkingLink).textContent).toContain(AUTH_NOTICES.checkingLink);
    await flushMicrotasks();
    expect(readSession()).toBeNull();
    expect(screen.getByTestId(loginTestid.email)).toHaveValue("");

    cleanup();
    clearConsumedAuthRedirect();
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    at(`/login${link("signup", EMAIL).hash}`);
    render(<LoginRoute />);
    const unchecked = await screen.findByTestId(loginTestid.linkUnchecked);
    expect(unchecked.textContent).toContain(AUTH_NOTICES.linkUnchecked);
    expect(screen.getByTestId(loginTestid.resend)).toBeInTheDocument();
    expect(readSession()).toBeNull();
  });

  it("R193 a sign-in made while the link is being checked is not overridden when the check answers", async () => {
    rememberPendingEmail(EMAIL);
    const { token, hash } = link("signup", EMAIL);
    let answerMe: (response: Response) => void = () => undefined;
    const meAnswered = new Promise<Response>((resolve) => {
      answerMe = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/auth/me") return meAnswered;
        const renewal = renewalAnswer(url, typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
        if (renewal !== null) return Promise.resolve(renewal);
        return Promise.resolve(providerResponse(SIGNED_IN.status, SIGNED_IN.body));
      }),
    );
    at(`/login${hash}`);
    render(<LoginRoute />);
    setField(loginTestid.email, EMAIL);
    setField(loginTestid.password, PASSWORD);
    submitForm();
    await waitFor(() => {
      expect(readSession()?.accessToken).toBe(SIGNED_IN.body.access_token);
    });
    answerMe(
      providerResponse(200, {
        profile: { id: "p", status: "pending", rating: 1000 },
        needsInviteCode: true,
        emailVerified: true,
        currentMatchId: null,
        email: EMAIL,
      }),
    );
    await flushMicrotasks();
    expect(readSession()?.accessToken).toBe(SIGNED_IN.body.access_token);
    expect(readSession()?.accessToken).not.toBe(token);
  });

  it("R193 a sign-in forgets the pending address, and the pending reset with it", async () => {
    rememberPendingEmail(EMAIL);
    // An address planted on a shared computer (or left by the last person) must not survive.
    rememberPendingReset("attacker@evil.example");
    provider({ "/auth/v1/token": SIGNED_IN });
    render(<LoginRoute />);
    setField(loginTestid.email, EMAIL);
    setField(loginTestid.password, PASSWORD);
    submitForm();
    await waitFor(() => {
      expect(window.location.pathname).toBe(paths.decks);
    });
    expect(readSession()?.accessToken).toBe(SIGNED_IN.body.access_token);
    expect(pendingEmail()).toBeNull();
    expect(pendingReset()).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// B30 / R193: recovery and error links
// ---------------------------------------------------------------------------------------------

describe("R193 B30 recovery and error links", () => {
  it("R193 a recovery link for the address this browser asked to reset holds its session for this tab only and goes to /reset-password", async () => {
    rememberPendingReset(EMAIL);
    const stored = window.localStorage.length;
    const recovery = link("recovery", EMAIL);
    const { token, hash } = recovery;
    server({ [token]: EMAIL });
    at(`/login${hash}`);
    render(<LoginRoute />);

    await waitFor(() => {
      expect(window.location.pathname).toBe(paths.resetPassword);
    });
    expect(window.localStorage.length, "nothing written to localStorage").toBe(stored);
    expect(readSession()).toBeNull();
    // The renewal is held: the refresh token in the link's URL was spent on arrival.
    expect(recoverySession()).toEqual({ session: linkSession(recovery), email: EMAIL });
    expect(window.location.href).not.toContain(token);
  });

  it("R193 a forged recovery token naming the requested address holds nothing", async () => {
    rememberPendingReset(EMAIL);
    const { hash } = link("recovery", EMAIL);
    server({});
    at(`/login${hash}`);
    render(<LoginRoute />);
    await screen.findByTestId(loginTestid.linkError);
    await flushMicrotasks();
    expect(recoverySession()).toBeNull();
    expect(window.location.pathname).toBe(paths.login);
  });

  it("R193 the address is compared as the provider compares it: trimmed, in any case", async () => {
    rememberPendingReset(`  ${EMAIL.toUpperCase()} `);
    const { token, hash } = link("recovery", EMAIL);
    server({ [token]: EMAIL });
    at(`/login${hash}`);
    render(<LoginRoute />);
    await waitFor(() => {
      expect(window.location.pathname).toBe(paths.resetPassword);
    });
  });

  it.each([
    ["no reset was asked for in this browser", null],
    ["the reset asked for was another address", "someone.else@example.com"],
  ] as const)("R193 a recovery link is held back when %s: nothing is held or stored until the player types its address", async (_name, requested) => {
    if (requested !== null) rememberPendingReset(requested);
    // A reset asked for on another device, or an attacker's own reset link sent to a victim.
    const { token, hash } = link("recovery", "attacker@evil.example");
    const calls = server({ [token]: "attacker@evil.example" });
    at(`/login${hash}`);
    render(<LoginRoute />);

    const claim = await screen.findByTestId(loginTestid.recoveryClaim);
    expect(claim.textContent).toBe(AUTH_NOTICES.recoveryClaim);
    expect(form()).toHaveAttribute("data-mode", "claimReset");
    // The link's address is never shown or filled in: the player types their own.
    expect(screen.getByTestId(loginTestid.email)).toHaveValue("");
    expect(bodyText()).not.toContain("attacker@evil.example");
    expect(screen.queryByTestId(loginTestid.password)).toBeNull();
    await flushMicrotasks();
    expect(window.location.pathname).toBe(paths.login);
    expect(recoverySession()).toBeNull();
    expect(readSession()).toBeNull();
    expect(callsTo(calls, "/auth/v1/logout")).toHaveLength(0);
    expect(window.location.href).not.toContain(token);
  });

  it("R193 a reset asked for on another device works here once the player types the address it was sent to", async () => {
    // Asked for on a laptop, opened on a phone: this browser remembers no reset.
    const recovery = link("recovery", EMAIL);
    const calls = server({ [recovery.token]: EMAIL });
    at(`/login${recovery.hash}`);
    render(<LoginRoute />);
    await screen.findByTestId(loginTestid.recoveryClaim);

    // A typo is refused beside the field, and the link stays for the corrected address.
    setField(loginTestid.email, "player@example.org");
    submitForm();
    expect(screen.getByTestId(loginTestid.emailError).textContent).toBe(AUTH_NOTICES.recoveryClaimMismatch);
    expect(recoverySession()).toBeNull();

    // Compared as the provider compares it: trimmed, in any case.
    setField(loginTestid.email, `  ${EMAIL.toUpperCase()} `);
    submitForm();
    await waitFor(() => {
      expect(window.location.pathname).toBe(paths.resetPassword);
    });
    expect(recoverySession()).toEqual({ session: linkSession(recovery), email: EMAIL });
    expect(readSession()).toBeNull();
    await flushMicrotasks();
    expect(callsTo(calls, "/auth/v1/logout")).toHaveLength(0);
  });

  it("R193 someone sent another person's reset link types their own address: nothing is held, and their session is untouched", async () => {
    const victim = { accessToken: jwt({ sub: "victim", email: "victim@example.com" }), refreshToken: "victim-refresh" };
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(victim));
    const { token, hash } = link("recovery", "attacker@evil.example");
    server({ [token]: "attacker@evil.example" });
    at(`/login${hash}`);
    render(<LoginRoute />);

    await screen.findByTestId(loginTestid.recoveryClaim);
    setField(loginTestid.email, "victim@example.com");
    submitForm();
    await flushMicrotasks();
    expect(screen.getByTestId(loginTestid.emailError).textContent).toBe(AUTH_NOTICES.recoveryClaimMismatch);
    expect(window.location.pathname).toBe(paths.login);
    expect(recoverySession()).toBeNull();
    expect(readSession()?.accessToken).toBe(victim.accessToken);
  });

  it("R193 a recovery link held back for its address offers a new link instead, which starts empty and waits for nothing", async () => {
    const { token, hash } = link("recovery", EMAIL);
    server({ [token]: EMAIL });
    at(`/login${hash}`);
    render(<LoginRoute />);

    await screen.findByTestId(loginTestid.recoveryClaim);
    fireEvent.click(screen.getByTestId(loginTestid.forgot));
    expect(form()).toHaveAttribute("data-mode", "forgot");
    expect(screen.getByTestId(loginTestid.email)).toHaveValue("");
    // No wait is started for an address this browser never mailed (R192).
    setField(loginTestid.email, EMAIL);
    expect(screen.getByTestId(loginTestid.submit)).toBeEnabled();
    expect(screen.queryByTestId(loginTestid.resetCooldown)).toBeNull();
  });

  it("R193 a recovery link whose account has no address to compare holds nothing and says so", async () => {
    const { token, hash } = link("recovery", null);
    server({ [token]: null }, { "/auth/v1/logout": { status: 204 } });
    at(`/login${hash}`);
    render(<LoginRoute />);

    const refused = await screen.findByTestId(loginTestid.recoveryRefused);
    expect(refused.textContent).toBe(AUTH_NOTICES.recoveryElsewhere);
    expect(refused.textContent).toMatch(/only once/);
    await flushMicrotasks();
    expect(recoverySession()).toBeNull();
    expect(screen.getAllByTestId(loginTestid.forgot).length).toBeGreaterThan(0);
  });

  it.each([
    ["the fragment", "#"],
    ["the query", "?"],
  ] as const)("R193 an otp_expired link in %s shows linkExpired with resend and forgot beside it", async (_name, lead) => {
    const params = new URLSearchParams({
      error: "access_denied",
      error_code: "otp_expired",
      error_description: PROVIDER_DESCRIPTION,
    });
    at(`/login${lead}${params.toString()}`);
    render(<LoginRoute />);

    const error = await screen.findByTestId(loginTestid.linkError);
    expect(error.textContent).toContain(AUTH_MESSAGES.linkExpired);
    // A mail scanner may have spent the link: a confirmation it spent still confirmed the address.
    expect(screen.getByTestId(loginTestid.linkErrorSignIn).textContent).toMatch(/sign in/i);
    expect(screen.getByTestId(loginTestid.password)).toBeInTheDocument();
    expect(screen.getByTestId(loginTestid.resend)).toBeInTheDocument();
    expect(screen.getByTestId(loginTestid.forgot)).toBeInTheDocument();
    expect(bodyText()).not.toContain("PROVIDER-DESCRIPTION");
    expect(window.location.href).not.toContain("otp_expired");
    expect(window.location.href).not.toContain("error_description");
    expect(readSession()).toBeNull();
  });

  it("R193 any other link error shows the same sentence", async () => {
    const params = new URLSearchParams({
      error: "server_error",
      error_code: "unexpected_failure",
      error_description: PROVIDER_DESCRIPTION,
    });
    at(`/login#${params.toString()}`);
    render(<LoginRoute />);
    const error = await screen.findByTestId(loginTestid.linkError);
    expect(error.textContent).toContain(AUTH_MESSAGES.linkExpired);
    expect(bodyText()).not.toContain("PROVIDER-DESCRIPTION");
  });

  it("R193 markup in error_description is never rendered", async () => {
    const params = new URLSearchParams({
      error: "access_denied",
      error_code: "otp_expired",
      error_description: '<img src="x" onerror="window.__pwned = true"><b>bold</b>',
    });
    at(`/login#${params.toString()}`);
    const { container } = render(<LoginRoute />);
    await screen.findByTestId(loginTestid.linkError);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(bodyText()).not.toContain("onerror");
    expect((window as unknown as { __pwned?: unknown }).__pwned).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// B33: the expired-session notice
// ---------------------------------------------------------------------------------------------

describe("B33 /login?reason=expired", () => {
  it("B33 shows login-session-expired with the sessionExpired notice", () => {
    at("/login?reason=expired");
    render(<LoginRoute />);
    expect(screen.getByTestId(loginTestid.sessionExpired).textContent).toContain(AUTH_NOTICES.sessionExpired);
  });

  it.each([["/login"], ["/login?reason=Expired"], ["/login?reason=banned"]] as const)(
    "B33 %s shows no expired-session notice",
    (url) => {
      at(url);
      render(<LoginRoute />);
      expect(screen.queryByTestId(loginTestid.sessionExpired)).toBeNull();
    },
  );
});

// ---------------------------------------------------------------------------------------------
// B35: no destination is read from a URL
// ---------------------------------------------------------------------------------------------

describe("B35 fixed destinations", () => {
  it("B35 /login?next=https://evil.example then a sign-in lands on /decks", async () => {
    at("/login?next=https://evil.example/steal");
    const origin = window.location.origin;
    provider({ "/auth/v1/token": SIGNED_IN });
    render(<LoginRoute />);
    setField(loginTestid.email, EMAIL);
    setField(loginTestid.password, PASSWORD);
    submitForm();

    await waitFor(() => {
      expect(window.location.pathname).toBe(paths.decks);
    });
    expect(window.location.origin).toBe(origin);
    expect(window.location.href).not.toContain("evil.example");
  });

  it("R193 a confirmation link carrying a redirect of its own stays on the sign-in screen and follows nothing", async () => {
    rememberPendingEmail(EMAIL);
    const { token, hash } = link("signup", EMAIL);
    server({ [token]: EMAIL });
    at(`/login?redirect_to=${encodeURIComponent("https://evil.example/")}&next=%2F%2Fevil.example${hash}`);
    const origin = window.location.origin;
    render(<LoginRoute />);
    await screen.findByTestId(loginTestid.confirmed);
    expect(window.location.pathname).toBe(paths.login);
    expect(window.location.origin).toBe(origin);
    expect(window.location.href).not.toContain("evil.example");
  });

  it("B35 sign-up's confirmation redirect is <origin>/login even when the page URL names another", async () => {
    at(`/login?redirect_to=${encodeURIComponent("https://evil.example/")}`);
    const calls = provider({ "/auth/v1/signup": { status: 200, body: { id: "user-1" } } });
    render(<LoginRoute />);
    toSignUp();
    setField(loginTestid.email, EMAIL);
    setField(loginTestid.password, PASSWORD);
    submitForm();
    await waitFor(() => {
      expect(callsTo(calls, "/auth/v1/signup")).toHaveLength(1);
    });
    expect(callsTo(calls, "/auth/v1/signup")[0]?.url.searchParams.get("redirect_to")).toBe(
      `${window.location.origin}/login`,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// B24: a shown password is not rewritten by a phone keyboard
// ---------------------------------------------------------------------------------------------

describe("B24 show password", () => {
  it("B24 the password field is never auto-capitalised, auto-corrected or spell-checked, shown or hidden", () => {
    render(<LoginRoute />);
    const input = screen.getByTestId(loginTestid.password);
    for (const shown of [false, true]) {
      if (shown) fireEvent.click(screen.getByTestId(loginTestid.togglePassword));
      expect(input).toHaveAttribute("type", shown ? "text" : "password");
      expect(input).toHaveAttribute("autocapitalize", "none");
      expect(input).toHaveAttribute("autocorrect", "off");
      expect(input).toHaveAttribute("spellcheck", "false");
    }
  });
});

// ---------------------------------------------------------------------------------------------
// After the second panel: what the screen says on the way in, and the sessions it replaces
// ---------------------------------------------------------------------------------------------

describe("R193 the addresses this browser waits on", () => {
  it("R193 an address remembered longer ago than an emailed link can live arms nothing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    rememberPendingEmail(EMAIL);
    rememberPendingReset(EMAIL);
    vi.setSystemTime(1_800_000_000_000 + AUTH_PENDING_ADDRESS_TTL_SECONDS * 1000 - 1);
    expect(pendingEmail()).toBe(EMAIL);
    vi.setSystemTime(1_800_000_000_000 + AUTH_PENDING_ADDRESS_TTL_SECONDS * 1000 + 1);
    expect(pendingEmail()).toBeNull();
    expect(pendingReset()).toBeNull();
  });

  it("R193 a bare address written by hand (an older build, or a planted one) arms nothing", () => {
    window.localStorage.setItem("jackioh.auth.pendingReset", "attacker@evil.example");
    window.localStorage.setItem("jackioh.auth.pendingEmail", "attacker@evil.example");
    expect(pendingReset()).toBeNull();
    expect(pendingEmail()).toBeNull();
  });

  it("R193 /login?mode=forgot fills in nothing from storage, not even a reset another person asked for on this device", () => {
    // Person A asked for a reset here and left without signing in; the address lives a day.
    rememberPendingReset("person-a@example.com");
    // Anyone can open this URL (the reset screen's "Email me a new link" opens it too).
    at("/login?mode=forgot");
    render(<LoginRoute />);
    expect(form()).toHaveAttribute("data-mode", "forgot");
    expect(screen.getByTestId(loginTestid.email)).toHaveValue("");
    expect(bodyText()).not.toContain("person-a@example.com");
  });
});

describe("the way in, said before it is needed", () => {
  it("the create-account form says online play needs an invite code", () => {
    render(<LoginRoute />);
    expect(screen.queryByTestId(loginTestid.inviteOnly)).toBeNull();
    toSignUp();
    expect(screen.getByTestId(loginTestid.inviteOnly).textContent).toBe(AUTH_NOTICES.inviteOnly);
    expect(AUTH_NOTICES.inviteOnly).toMatch(/invite code/);
  });

  it("R160 the sign-up notice offers the way on to a player who already has an account, for every address alike", () => {
    expect(AUTH_NOTICES.signUpSent).toMatch(/confirmation link/);
    expect(AUTH_NOTICES.signUpSent).toMatch(/already have an account/);
    expect(AUTH_NOTICES.signUpSent).toMatch(/reset your password/);
  });

  it("R160 signing in straight after signing up says to open the confirmation link first", async () => {
    provider({
      "/auth/v1/signup": { status: 200, body: { id: "user-1" } },
      "/auth/v1/token": { status: 400, body: { error_code: "email_not_confirmed", msg: PROVIDER_MSG } },
    });
    render(<LoginRoute />);
    toSignUp();
    setField(loginTestid.email, EMAIL);
    setField(loginTestid.password, PASSWORD);
    submitForm();
    await waitFor(() => {
      expect(form()).toHaveAttribute("data-mode", "signIn");
    });
    setField(loginTestid.password, PASSWORD);
    submitForm();

    const hint = await screen.findByTestId(loginTestid.confirmFirst);
    expect(hint.textContent).toBe(AUTH_NOTICES.confirmFirst);
    // R160 stands: the refusal itself is the one sentence, whatever the provider said.
    expect(screen.getByTestId(loginTestid.error).textContent).toBe(SIGN_IN_FAILED_MESSAGE);
    expect(bodyText()).not.toContain(PROVIDER_MSG);
  });

  it("R160 the hint is keyed on this browser's sign-up only: another address, or none, gets none", async () => {
    rememberPendingEmail("someone-else@example.com");
    provider({ "/auth/v1/token": { status: 400, body: { error_code: "invalid_credentials" } } });
    render(<LoginRoute />);
    setField(loginTestid.email, EMAIL);
    setField(loginTestid.password, PASSWORD);
    submitForm();
    await screen.findByTestId(loginTestid.error);
    expect(screen.queryByTestId(loginTestid.confirmFirst)).toBeNull();
  });
});

describe("R194 a session another account replaces is revoked", () => {
  it("R194 signing in as B over A's session revokes A at the provider", async () => {
    const aAccess = jwt({ sub: "a", email: "a@example.com" });
    window.localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ accessToken: aAccess, refreshToken: "a-refresh", expiresAt: LINK_EXPIRES_AT_S * 1000 }),
    );
    const bearers: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === "/auth/v1/logout") {
          bearers.push(new Headers(init?.headers).get("authorization") ?? "");
          return Promise.resolve(providerResponse(204));
        }
        return Promise.resolve(providerResponse(SIGNED_IN.status, SIGNED_IN.body));
      }),
    );
    render(<LoginRoute />);
    setField(loginTestid.email, EMAIL);
    setField(loginTestid.password, PASSWORD);
    submitForm();
    await waitFor(() => {
      expect(window.location.pathname).toBe(paths.decks);
    });
    await waitFor(() => {
      expect(bearers).toContain(`Bearer ${aAccess}`);
    });
    expect(readSession()?.accessToken).toBe(SIGNED_IN.body.access_token);
  });

  it("R193 R194 a confirmation link leaves the session this browser already has alone, and revokes only its own", async () => {
    const aAccess = jwt({ sub: "a", email: "a@example.com" });
    window.localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ accessToken: aAccess, refreshToken: "a-refresh", expiresAt: LINK_EXPIRES_AT_S * 1000 }),
    );
    rememberPendingEmail(EMAIL);
    const { token, hash, renewed } = link("signup", EMAIL);
    const calls = server({ [token]: EMAIL }, { "/auth/v1/logout": { status: 204 } });
    at(`/login${hash}`);
    render(<LoginRoute />);
    await screen.findByTestId(loginTestid.confirmed);
    await flushMicrotasks();
    expect(readSession()?.accessToken).toBe(aAccess);
    expect(callsTo(calls, "/auth/v1/logout").map((call) => call.auth)).toEqual([`Bearer ${renewed}`]);
  });
});


// ---------------------------------------------------------------------------------------------
// R193: a link never arms this browser's guard with an address the player did not type
// ---------------------------------------------------------------------------------------------

describe("R193 an address from a link is never put in a form", () => {
  const ATTACKER = "attacker@evil.example";

  /** One of the attacker's own real tokens, sent in a link with a `type` of their choosing. */
  function attackerLink(type: string, tag: string): { token: string; hash: string } {
    const token = jwt({ sub: "attacker", email: ATTACKER, tag });
    renewable(token, `refresh-${tag}`, { sub: "attacker", email: ATTACKER, tag });
    const params = new URLSearchParams({
      access_token: token,
      refresh_token: `refresh-${tag}`,
      expires_at: String(LINK_EXPIRES_AT_S),
      token_type: "bearer",
      type,
    });
    return { token, hash: `#${params.toString()}` };
  }

  function open(hash: string): void {
    cleanup();
    clearConsumedAuthRedirect();
    at(`/login${hash}`);
    render(<LoginRoute />);
  }

  it("R193 a crafted invite link opens the forgot form empty: one click cannot arm the reset guard with its address", async () => {
    const first = attackerLink("invite", "first");
    const calls = server({ [first.token]: ATTACKER }, { "/auth/v1/recover": { status: 200, body: {} } });
    open(first.hash);

    await screen.findByTestId(loginTestid.invited);
    expect(form()).toHaveAttribute("data-mode", "forgot");
    expect(screen.getByTestId(loginTestid.email)).toHaveValue("");

    // The victim does what the screen says, without typing: the form asks for an address.
    submitForm();
    await flushMicrotasks();
    expect(screen.getByTestId(loginTestid.emailError)).toBeInTheDocument();
    expect(callsTo(calls, "/auth/v1/recover")).toHaveLength(0);
    expect(pendingReset()).toBeNull();
  });

  it("R193 the whole chain fails: a reset link held back, a send pressed without typing, then a second link holds nothing", async () => {
    const victim = { accessToken: jwt({ sub: "victim", email: "victim@example.com" }), refreshToken: "victim-refresh" };
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(victim));
    const first = attackerLink("recovery", "first");
    const second = attackerLink("recovery", "second");
    const calls = server(
      { [first.token]: ATTACKER, [second.token]: ATTACKER },
      { "/auth/v1/recover": { status: 200, body: {} } },
    );

    open(first.hash);
    await screen.findByTestId(loginTestid.recoveryClaim);
    // The claim form is empty too: pressing Continue without typing holds nothing.
    expect(screen.getByTestId(loginTestid.email)).toHaveValue("");
    submitForm();
    expect(screen.getByTestId(loginTestid.emailError)).toBeInTheDocument();
    expect(recoverySession()).toBeNull();
    fireEvent.click(screen.getByTestId(loginTestid.forgot));
    expect(screen.getByTestId(loginTestid.email)).toHaveValue("");
    submitForm();
    await flushMicrotasks();
    expect(callsTo(calls, "/auth/v1/recover")).toHaveLength(0);
    expect(pendingReset()).toBeNull();

    open(second.hash);
    await screen.findByTestId(loginTestid.recoveryClaim);
    await flushMicrotasks();
    expect(window.location.pathname).toBe(paths.login);
    expect(recoverySession()).toBeNull();
    expect(readSession()?.accessToken).toBe(victim.accessToken);
  });

  it("R193 a confirmation link from elsewhere fills in nothing, so a failed sign-in's resend cannot arm pendingEmail with its address", async () => {
    const first = attackerLink("signup", "first");
    const second = attackerLink("signup", "second");
    const calls = server(
      { [first.token]: ATTACKER, [second.token]: ATTACKER },
      {
        "/auth/v1/token": { status: 400, body: { error_code: "invalid_credentials" } },
        "/auth/v1/resend": { status: 200, body: {} },
      },
    );

    open(first.hash);
    await screen.findByTestId(loginTestid.confirmed);
    expect(screen.getByTestId(loginTestid.email)).toHaveValue("");
    // The victim types only a password and presses Sign in: the form asks for the address.
    setField(loginTestid.password, PASSWORD);
    submitForm();
    await flushMicrotasks();
    expect(screen.getByTestId(loginTestid.emailError)).toBeInTheDocument();
    // No sign-in was tried (the link's own renewal, on arrival, is the only token request).
    expect(
      callsTo(calls, "/auth/v1/token").filter((call) => call.url.searchParams.get("grant_type") === "password"),
    ).toHaveLength(0);
    expect(callsTo(calls, "/auth/v1/resend")).toHaveLength(0);
    expect(pendingEmail()).toBeNull();

    open(second.hash);
    await screen.findByTestId(loginTestid.confirmed);
    await flushMicrotasks();
    expect(readSession()).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// R193: a link's session this browser does not keep is revoked
// ---------------------------------------------------------------------------------------------

describe("R193 a link's session that is not kept is revoked at the provider", () => {
  it.each([
    ["a confirmation link for a sign-up started elsewhere", "signup", loginTestid.confirmed],
    ["a confirmation link for the sign-up this browser started", "signup-here", loginTestid.confirmed],
    ["a dashboard invite", "invite", loginTestid.invited],
  ] as const)("R193 %s: its tokens were in the URL, so they are revoked", async (_name, type, outcome) => {
    if (type === "signup-here") rememberPendingEmail(EMAIL);
    const { token, hash, renewed } = link(type === "signup-here" ? "signup" : type, EMAIL);
    const calls = server({ [token]: EMAIL }, { "/auth/v1/logout": { status: 204 } });
    at(`/login${hash}`);
    render(<LoginRoute />);
    await screen.findByTestId(outcome);
    await flushMicrotasks();

    expect(readSession()).toBeNull();
    const logouts = callsTo(calls, "/auth/v1/logout");
    expect(logouts).toHaveLength(1);
    expect(logouts[0]?.auth).toBe(`Bearer ${renewed}`);
    expect(logouts[0]?.url.searchParams.get("scope")).toBe("local");
  });

  it.each([
    ["asks for a new link instead", loginTestid.forgot],
    ["goes back to sign in", loginTestid.backToSignIn],
  ] as const)("R193 a recovery link held back for its address is revoked when the player %s", async (_name, exit) => {
    const { token, hash, renewed } = link("recovery", EMAIL);
    const calls = server({ [token]: EMAIL }, { "/auth/v1/logout": { status: 204 } });
    at(`/login${hash}`);
    render(<LoginRoute />);
    await screen.findByTestId(loginTestid.recoveryClaim);
    await flushMicrotasks();
    expect(callsTo(calls, "/auth/v1/logout")).toHaveLength(0);

    fireEvent.click(screen.getByTestId(exit));
    await flushMicrotasks();
    expect(callsTo(calls, "/auth/v1/logout").map((call) => call.auth)).toEqual([`Bearer ${renewed}`]);
    expect(recoverySession()).toBeNull();
  });

  it("R193 a recovery link held back for its address is revoked when the screen is left", async () => {
    const { token, hash, renewed } = link("recovery", EMAIL);
    const calls = server({ [token]: EMAIL }, { "/auth/v1/logout": { status: 204 } });
    at(`/login${hash}`);
    const view = render(<LoginRoute />);
    await screen.findByTestId(loginTestid.recoveryClaim);
    view.unmount();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(callsTo(calls, "/auth/v1/logout").map((call) => call.auth)).toEqual([`Bearer ${renewed}`]);
  });

  it("R193 a link the player moved on from before it was checked is revoked too", async () => {
    const { hash, renewed } = link("recovery", EMAIL);
    let answerMe: (response: Response) => void = () => undefined;
    const meAnswered = new Promise<Response>((resolve) => {
      answerMe = resolve;
    });
    const logouts: (string | null)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/auth/me") return meAnswered;
        if (url.pathname === "/auth/v1/logout") logouts.push(new Headers(init?.headers).get("authorization"));
        const renewal = renewalAnswer(url, typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
        if (renewal !== null) return Promise.resolve(renewal);
        return Promise.resolve(providerResponse(204));
      }),
    );
    at(`/login${hash}`);
    render(<LoginRoute />);
    await flushMicrotasks();
    fireEvent.click(screen.getByTestId(loginTestid.mode));
    answerMe(
      providerResponse(200, {
        profile: { id: "p", status: "pending", rating: 1000 },
        needsInviteCode: true,
        emailVerified: true,
        currentMatchId: null,
        email: EMAIL,
      }),
    );
    await flushMicrotasks();
    // Revoked when the player moved on, once: the answer that came after finds nothing to revoke.
    expect(logouts).toEqual([`Bearer ${renewed}`]);
  });

  it("R193 a link's refresh token is spent before the server is asked whose it is, and the check carries the renewal", async () => {
    rememberPendingReset(EMAIL);
    const recovery = link("recovery", EMAIL);
    const calls = server({ [recovery.token]: EMAIL });
    at(`/login${recovery.hash}`);
    render(<LoginRoute />);
    await waitFor(() => {
      expect(window.location.pathname).toBe(paths.resetPassword);
    });

    const order = calls
      .filter((call) => call.url.pathname === "/api/auth/me" || call.url.searchParams.get("grant_type") === "refresh_token")
      .map((call) => (call.url.pathname === "/api/auth/me" ? `check ${call.auth ?? ""}` : "renew"));
    // StrictMode is off here, so exactly one of each, the renewal first.
    expect(order).toEqual(["renew", `check Bearer ${recovery.renewed}`]);
    const renewal = calls.find((call) => call.url.searchParams.get("grant_type") === "refresh_token");
    expect(renewal?.body).toEqual({ refresh_token: recovery.refresh });
  });

  it("R193 a link whose refresh token was already spent (opened again from history) holds nothing and revokes nothing", async () => {
    rememberPendingReset(EMAIL);
    const recovery = link("recovery", EMAIL);
    // The provider has rotated this refresh token already, and refuses it now.
    renewals.delete(recovery.refresh);
    const calls = server({ [recovery.token]: EMAIL });
    at(`/login${recovery.hash}`);
    render(<LoginRoute />);
    await screen.findByTestId(loginTestid.linkError);
    await flushMicrotasks();
    expect(recoverySession()).toBeNull();
    expect(window.location.pathname).toBe(paths.login);
    // Not even asked about: a spent link decides nothing.
    expect(callsTo(calls, "/api/auth/me")).toHaveLength(0);
    expect(callsTo(calls, "/auth/v1/logout")).toHaveLength(0);
  });

  it("R193 a link the server refused holds nothing, and the renewal it was checked with is revoked", async () => {
    const { hash, renewed } = link("recovery", EMAIL);
    const calls = server({}, { "/auth/v1/logout": { status: 204 } });
    at(`/login${hash}`);
    render(<LoginRoute />);
    await screen.findByTestId(loginTestid.linkError);
    await flushMicrotasks();
    expect(recoverySession()).toBeNull();
    expect(callsTo(calls, "/auth/v1/logout").map((call) => call.auth)).toEqual([`Bearer ${renewed}`]);
  });

  it("R193 a recovery link this browser holds for a reset is not revoked", async () => {
    rememberPendingReset(EMAIL);
    const { token, hash } = link("recovery", EMAIL);
    const calls = server({ [token]: EMAIL });
    at(`/login${hash}`);
    render(<LoginRoute />);
    await waitFor(() => {
      expect(window.location.pathname).toBe(paths.resetPassword);
    });
    await flushMicrotasks();
    expect(callsTo(calls, "/auth/v1/logout")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// R192: the provider's interval survives a reload and another device, and is counted on the clock
// ---------------------------------------------------------------------------------------------

describe("R192 the mail interval, wherever it started", () => {
  it("R192 a reset asked for moments ago in this browser is not asked for again after a reload", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    rememberPendingReset(EMAIL);
    const calls = provider({ "/auth/v1/recover": { status: 200, body: {} } });
    at("/login?mode=forgot");
    render(<LoginRoute />);

    // Nothing is filled in (R193); the interval belongs to the address the player types.
    expect(screen.getByTestId(loginTestid.email)).toHaveValue("");
    setField(loginTestid.email, EMAIL);
    const submit = screen.getByTestId(loginTestid.submit);
    expect(submit).toBeDisabled();
    // The wait is said once, under the button; the button keeps its name while it is locked.
    expect(submit.textContent).toBe("Send reset link");
    // Only the wait: whether a mail went out is the neutral notice's to say (R192).
    expect(screen.getByTestId(loginTestid.resetCooldown).textContent).toMatch(/^You can ask for another in \d+ s\.$/);
    submitForm();
    await flushMicrotasks();
    expect(callsTo(calls, "/auth/v1/recover")).toHaveLength(0);
    expect(bodyText()).not.toContain(AUTH_NOTICES.resetSent);

    act(() => {
      vi.advanceTimersByTime(AUTH_EMAIL_RESEND_COOLDOWN_SECONDS * 1000);
    });
    expect(screen.getByTestId(loginTestid.submit)).toBeEnabled();
  });

  it("R192 a sign-up moments ago in this browser still holds the resend after a reload", async () => {
    rememberPendingEmail(EMAIL);
    provider({ "/auth/v1/token": { status: 400, body: { error_code: "invalid_credentials" } } });
    render(<LoginRoute />);
    setField(loginTestid.email, EMAIL);
    setField(loginTestid.password, PASSWORD);
    submitForm();
    const resend = await screen.findByTestId(loginTestid.resend);
    expect(resend).toBeDisabled();
    expect(screen.getByTestId(loginTestid.resendCooldown)).toBeInTheDocument();
  });

  it("R192 an interval that ran out while the page was closed holds nothing", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    rememberPendingReset(EMAIL);
    vi.setSystemTime(Date.now() + (AUTH_EMAIL_RESEND_COOLDOWN_SECONDS + 1) * 1000);
    at("/login?mode=forgot");
    render(<LoginRoute />);
    expect(screen.getByTestId(loginTestid.submit)).toBeEnabled();
  });

  it("R192 a reset link opened on another device, then a new link asked for, answers the neutral sentence however the provider answers", async () => {
    const { token, hash } = link("recovery", EMAIL);
    const calls = server({ [token]: EMAIL }, { "/auth/v1/recover": { status: 429, body: { error_code: "over_email_send_rate_limit" } } });
    at(`/login${hash}`);
    render(<LoginRoute />);
    await screen.findByTestId(loginTestid.recoveryClaim);
    fireEvent.click(screen.getByTestId(loginTestid.forgot));

    setField(loginTestid.email, EMAIL);
    expect(screen.getByTestId(loginTestid.submit)).toBeEnabled();
    submitForm();
    await flushMicrotasks();
    expect(callsTo(calls, "/auth/v1/recover")).toHaveLength(1);
    // The provider refused inside its interval; the page says the same as for any address.
    expect(screen.getByTestId(loginTestid.notice).textContent).toBe(AUTH_NOTICES.resetSent);
    expect(screen.getByTestId(loginTestid.resetCooldown).textContent).toMatch(/^You can ask for another in \d+ s\.$/);
  });

  it("R192 the neutral notices say that a send inside the interval can't go out, for every address alike", () => {
    for (const notice of [AUTH_NOTICES.resetSent, AUTH_NOTICES.resendSent]) {
      expect(notice).toMatch(/in the last minute/);
      expect(notice).toMatch(/wait a minute, then ask again/);
    }
  });

  it("R192 the cooldown is counted on the clock: two minutes in the mail app, one tick later, resend is offered", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    provider({ "/auth/v1/signup": { status: 200, body: { id: "user-1" } } });
    render(<LoginRoute />);
    toSignUp();
    setField(loginTestid.email, EMAIL);
    setField(loginTestid.password, PASSWORD);
    submitForm();
    const resend = await screen.findByTestId(loginTestid.resend);
    expect(resend).toBeDisabled();
    // The countdown's interval is set up in an effect; flush it before the clock moves, or on a busy
    // machine the tick below can land before the interval exists (it failed so once, under load).
    await act(async () => {
      await Promise.resolve();
    });

    // A phone freezes a background tab's timers: the clock moves on, one tick arrives on return.
    vi.setSystemTime(Date.now() + 120_000);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId(loginTestid.resend)).toBeEnabled();
    expect(screen.queryByTestId(loginTestid.resendCooldown)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// What happened is said first, and the field to fix takes focus
// ---------------------------------------------------------------------------------------------

describe("the screen says what happened before the form", () => {
  it("after a sign-up, the 'check your email' notice sits above the sign-in form and takes focus", async () => {
    provider({ "/auth/v1/signup": { status: 200, body: { id: "user-1" } } });
    render(<LoginRoute />);
    toSignUp();
    setField(loginTestid.email, EMAIL);
    setField(loginTestid.password, PASSWORD);
    submitForm();

    const notice = await screen.findByTestId(loginTestid.notice);
    expect(notice.textContent).toBe(AUTH_NOTICES.signUpSent);
    expect(form().compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_PRECEDING).not.toBe(0);
    await waitFor(() => {
      expect(document.activeElement).toBe(notice);
    });
  });

  it("a refused sign-in's error sits above the form", async () => {
    provider({ "/auth/v1/token": { status: 400, body: { error_code: "invalid_credentials" } } });
    render(<LoginRoute />);
    setField(loginTestid.email, EMAIL);
    setField(loginTestid.password, PASSWORD);
    submitForm();
    const error = await screen.findByTestId(loginTestid.error);
    expect(form().compareDocumentPosition(error) & Node.DOCUMENT_POSITION_PRECEDING).not.toBe(0);
  });

  it.each([
    ["a bad email", "not-an-address", PASSWORD, "login-email"],
    ["a short password", EMAIL, "x", "login-password"],
  ] as const)("a sign-up refused for %s puts the caret in the field to fix", (_name, email, password, id) => {
    render(<LoginRoute />);
    toSignUp();
    setField(loginTestid.email, email);
    setField(loginTestid.password, password);
    submitForm();
    expect(document.activeElement?.id).toBe(id);
  });
});

// ---------------------------------------------------------------------------------------------
// The third panel round
// ---------------------------------------------------------------------------------------------

describe("R193 a recovery link the server could not check", () => {
  it("R193 is kept for 'Try again', says so in reset words, and offers no confirmation resend", async () => {
    rememberPendingReset(EMAIL);
    const recovery = link("recovery", EMAIL);
    const { hash } = recovery;
    let reachable = false;
    const logouts: (string | null)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === "/auth/v1/logout") {
          logouts.push(new Headers(init?.headers).get("authorization"));
          return Promise.resolve(providerResponse(204));
        }
        const renewal = renewalAnswer(url, typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
        if (renewal !== null) return Promise.resolve(renewal);
        if (url.pathname === "/api/auth/me") {
          // A phone briefly offline: our server cannot be reached, though the provider took the link.
          if (!reachable) return Promise.reject(new TypeError("Failed to fetch"));
          return Promise.resolve(
            providerResponse(200, {
              profile: { id: "p", status: "active", rating: 1000 },
              needsInviteCode: false,
              emailVerified: true,
              currentMatchId: null,
              email: EMAIL,
            }),
          );
        }
        return Promise.resolve(providerResponse(404, {}));
      }),
    );
    at(`/login${hash}`);
    render(<LoginRoute />);

    const notice = await screen.findByTestId(loginTestid.recoveryUnchecked);
    expect(notice.textContent).toBe(AUTH_NOTICES.recoveryUnchecked);
    expect(notice.textContent).not.toMatch(/email is confirmed/i);
    expect(screen.queryByTestId(loginTestid.linkUnchecked)).toBeNull();
    expect(screen.queryByTestId(loginTestid.resend)).toBeNull();
    expect(screen.getByTestId(loginTestid.forgot)).toBeInTheDocument();
    await flushMicrotasks();
    // The one-time link is not spent on a network blip.
    expect(logouts).toEqual([]);

    reachable = true;
    fireEvent.click(screen.getByTestId(loginTestid.linkRetry));
    await waitFor(() => {
      expect(window.location.pathname).toBe(paths.resetPassword);
    });
    // Renewed once, on arrival: "Try again" checks the same renewal rather than spending it twice.
    expect(recoverySession()).toEqual({ session: linkSession(recovery), email: EMAIL });
    expect(logouts).toEqual([]);
  });

  it("R193 is revoked once the player moves on from it", async () => {
    rememberPendingReset(EMAIL);
    const { token, hash } = link("recovery", EMAIL);
    const logouts: (string | null)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === "/auth/v1/logout") {
          logouts.push(new Headers(init?.headers).get("authorization"));
          return Promise.resolve(providerResponse(204));
        }
        return Promise.reject(new TypeError("Failed to fetch"));
      }),
    );
    at(`/login${hash}`);
    render(<LoginRoute />);
    await screen.findByTestId(loginTestid.recoveryUnchecked);

    fireEvent.click(screen.getByTestId(loginTestid.forgot));
    await flushMicrotasks();
    expect(logouts).toEqual([`Bearer ${token}`]);
  });
});

describe("R193 'Checking your link…' while the server wakes", () => {
  it("R193 says why it is slow after GATE_SLOW_NOTICE_SECONDS, and to keep the page open", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    rememberPendingEmail(EMAIL);
    server("hang");
    at(`/login${link("signup", EMAIL).hash}`);
    render(<LoginRoute />);
    expect(screen.getByTestId(loginTestid.checkingLink)).toBeInTheDocument();
    expect(screen.queryByTestId(loginTestid.checkingSlow)).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(GATE_SLOW_NOTICE_SECONDS * 1000);
    });
    const slow = screen.getByTestId(loginTestid.checkingSlow);
    expect(slow.textContent).toBe(AUTH_NOTICES.checkingSlow);
    expect(slow.textContent).toMatch(/waking up/);
    expect(slow.textContent).toMatch(/keep this page open/);
  });
});

describe("R194 the sign-in screen over another account's session", () => {
  const HOUSEMATE = "housemate@example.com";

  it("R194 says which account this browser is signed in as, with that account's screen and sign-out beside it", () => {
    window.localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({
        accessToken: jwt({ sub: "user-2", email: HOUSEMATE }),
        refreshToken: "r",
        expiresAt: LINK_EXPIRES_AT_S * 1000,
      }),
    );
    render(<LoginRoute />);
    const hint = screen.getByTestId(loginTestid.signedInAs);
    expect(hint.textContent).toContain(HOUSEMATE);
    expect(hint.textContent).toMatch(/signs it out of that account/);
    expect(screen.getByTestId(loginTestid.signedInAccount)).toHaveAttribute("href", paths.account);
    expect(screen.getByTestId(loginTestid.signedInSignOut)).toHaveTextContent("Sign out");
  });

  it("R194 says nothing of the kind when the browser holds no session", () => {
    render(<LoginRoute />);
    expect(screen.queryByTestId(loginTestid.signedInAs)).toBeNull();
  });
});

describe("B27 resend is offered only where it can help", () => {
  it.each([
    ["the provider could not be reached", (): Promise<Response> => Promise.reject(new TypeError("Failed to fetch"))],
    [
      "the provider rate-limited the sign-in",
      (): Promise<Response> => Promise.resolve(providerResponse(429, { error_code: "over_request_rate_limit" })),
    ],
  ] as const)("B27 not when %s", async (_name, answer) => {
    vi.stubGlobal("fetch", vi.fn(answer));
    render(<LoginRoute />);
    setField(loginTestid.email, EMAIL);
    setField(loginTestid.password, PASSWORD);
    submitForm();
    await screen.findByTestId(loginTestid.error);
    expect(screen.queryByTestId(loginTestid.resend)).toBeNull();
  });
});

describe("R192 one account of a send on the forgot form", () => {
  it("R192 after a send, the notice says what may have happened and the hint says only how long to wait", async () => {
    provider({ "/auth/v1/recover": { status: 200, body: {} } });
    at("/login?mode=forgot");
    render(<LoginRoute />);
    setField(loginTestid.email, EMAIL);
    submitForm();

    const notice = await screen.findByTestId(loginTestid.notice);
    expect(notice.textContent).toBe(AUTH_NOTICES.resetSent);
    const submit = screen.getByTestId(loginTestid.submit);
    expect(submit).toBeDisabled();
    expect(submit.textContent).toBe("Send reset link");
    const why = screen.getByTestId(loginTestid.resetCooldown);
    // No flat "was just sent" beside the notice's "if that address has an account".
    expect(why.textContent).not.toMatch(/was just sent/);
    expect(why.textContent).toMatch(/^You can ask for another in \d+ s\.$/);
    expect(Number(why.getAttribute("data-seconds"))).toBeGreaterThan(0);
  });
});

describe("B27 the resend button says who it is for", () => {
  it("B27 after a refused sign-in, the resend has a lead-in for a player who has just signed up", async () => {
    provider({ "/auth/v1/token": { status: 400, body: { error_code: "invalid_credentials" } } });
    render(<LoginRoute />);
    setField(loginTestid.email, EMAIL);
    setField(loginTestid.password, PASSWORD);
    submitForm();
    await screen.findByTestId(loginTestid.resend);
    const lead = screen.getByTestId(loginTestid.resendLead);
    expect(lead.textContent).toMatch(/Just signed up\?/);
    // The lead-in comes before the button it explains.
    expect(lead.compareDocumentPosition(screen.getByTestId(loginTestid.resend)) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });
});
