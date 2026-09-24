// `/reset-password` (docs/polish/5-sign-in.md, B31). With a recovery session held in memory, the
// screen sets a new password against the provider and only then stores the session (R193). Without
// one, it is a dead end no longer: it offers a new link and the way back to sign-in.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AUTH_PASSWORD_MAX_LENGTH, AUTH_PASSWORD_MIN_LENGTH } from "../../../server/src/config.ts";
import { holdRecoverySession, recoverySession, releaseRecoverySession } from "../auth/redirect.ts";
import { navTestid } from "./nav.tsx";
import { resetTestid } from "../auth/testids.ts";
import { confirmProblem, newPasswordProblem } from "../auth/validation.ts";
import { AUTH_MESSAGES } from "../net/auth.ts";
import { paths } from "../net/navigate.ts";
import { SESSION_STORAGE_KEY, pendingReset, readSession, rememberPendingReset } from "../net/session.ts";
import ResetPasswordRoute from "./reset-password.tsx";

const URL_ = "https://project.supabase.co";
const KEY = "sb_publishable_test";
const EMAIL = "player@example.com";
const PASSWORD = "y".repeat(AUTH_PASSWORD_MIN_LENGTH);
const RECOVERY = {
  accessToken: "recovery-access-token",
  refreshToken: "recovery-refresh-token",
  expiresAt: 2_000_000_000_000,
};

type Call = { url: URL; method: string; headers: Headers; body: unknown };

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

function provider(status: number, body?: unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : String((input as URL).href ?? input));
      calls.push({
        url,
        method: (init?.method ?? "GET").toUpperCase(),
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return Promise.resolve(providerResponse(status, body));
    }),
  );
  return calls;
}

function textOf(element: HTMLElement): string {
  return element instanceof HTMLInputElement ? element.value : (element.textContent ?? "");
}

function setField(testId: string, value: string): void {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
}

function submit(): void {
  fireEvent.submit(screen.getByTestId(resetTestid.form));
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", URL_);
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", KEY);
  window.localStorage.clear();
  window.sessionStorage.clear();
  releaseRecoverySession();
  window.history.replaceState(null, "", "/reset-password");
});

afterEach(() => {
  cleanup();
  releaseRecoverySession();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("B31 without a recovery session", () => {
  it("B31 shows reset-no-link, and no form", () => {
    render(<ResetPasswordRoute />);
    expect(screen.getByTestId(resetTestid.noLink)).toBeInTheDocument();
    expect(screen.queryByTestId(resetTestid.form)).toBeNull();
    expect(screen.queryByTestId(resetTestid.password)).toBeNull();
  });

  it("B31 reset-request-new opens the forgot form at /login?mode=forgot", () => {
    render(<ResetPasswordRoute />);
    fireEvent.click(screen.getByTestId(resetTestid.requestNew));
    expect(window.location.pathname).toBe(paths.login);
    expect(window.location.search).toBe("?mode=forgot");
  });

  it("B31 reset-back-to-sign-in goes to plain /login", () => {
    render(<ResetPasswordRoute />);
    fireEvent.click(screen.getByTestId(resetTestid.backToSignIn));
    expect(window.location.pathname).toBe(paths.login);
    expect(window.location.search).toBe("");
  });

  it("B31 a stored sign-in is not a recovery session", () => {
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ accessToken: "signed-in" }));
    render(<ResetPasswordRoute />);
    expect(screen.getByTestId(resetTestid.noLink)).toBeInTheDocument();
  });
});

describe("B31 with a recovery session", () => {
  beforeEach(() => {
    holdRecoverySession(RECOVERY, EMAIL);
  });

  it("B31 shows the address, both password fields hidden, and a show toggle", () => {
    render(<ResetPasswordRoute />);
    expect(screen.queryByTestId(resetTestid.noLink)).toBeNull();
    expect(textOf(screen.getByTestId(resetTestid.email))).toContain(EMAIL);
    const password = screen.getByTestId(resetTestid.password);
    expect(password).toHaveAttribute("type", "password");
    expect(screen.getByTestId(resetTestid.confirm)).toHaveAttribute("type", "password");

    fireEvent.click(screen.getByTestId(resetTestid.togglePassword));
    expect(password).toHaveAttribute("type", "text");
    fireEvent.click(screen.getByTestId(resetTestid.togglePassword));
    expect(password).toHaveAttribute("type", "password");
  });

  it.each([
    ["one under the minimum", AUTH_PASSWORD_MIN_LENGTH - 1],
    ["one over the maximum", AUTH_PASSWORD_MAX_LENGTH + 1],
  ] as const)("B31 refuses a new password %s without calling the provider", (_name, length) => {
    const calls = provider(200, {});
    render(<ResetPasswordRoute />);
    const password = "y".repeat(length);
    setField(resetTestid.password, password);
    setField(resetTestid.confirm, password);
    submit();

    expect(calls).toHaveLength(0);
    expect(screen.getByTestId(resetTestid.password)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByTestId(resetTestid.passwordError).textContent).toBe(newPasswordProblem(password));
    expect(readSession()).toBeNull();
  });

  it("B31 refuses a confirmation that does not match", () => {
    const calls = provider(200, {});
    render(<ResetPasswordRoute />);
    setField(resetTestid.password, PASSWORD);
    setField(resetTestid.confirm, `${PASSWORD}z`);
    submit();

    expect(calls).toHaveLength(0);
    expect(screen.getByTestId(resetTestid.confirm)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByTestId(resetTestid.confirmError).textContent).toBe(
      confirmProblem(PASSWORD, `${PASSWORD}z`),
    );
  });

  it("R193 B31 saves the password, then stores the session, releases the recovery and goes to /decks", async () => {
    const calls = provider(200, { id: "user-1", email: EMAIL });
    render(<ResetPasswordRoute />);
    setField(resetTestid.password, PASSWORD);
    setField(resetTestid.confirm, PASSWORD);
    submit();

    await waitFor(() => {
      expect(window.location.pathname).toBe(paths.decks);
    });
    expect(calls).toHaveLength(1);
    const call = calls[0] as Call;
    expect(call.method).toBe("PUT");
    expect(`${call.url.origin}${call.url.pathname}`).toBe(`${URL_}/auth/v1/user`);
    expect(call.body).toEqual({ password: PASSWORD });
    expect(call.headers.get("authorization")).toBe(`Bearer ${RECOVERY.accessToken}`);
    expect(readSession()?.accessToken).toBe(RECOVERY.accessToken);
    expect(recoverySession()).toBeNull();
  });

  it.each([
    ["same_password", 422, { error_code: "same_password" }, "samePassword"],
    ["weak_password", 422, { error_code: "weak_password" }, "weakPassword"],
    ["an expired recovery token", 401, { error_code: "bad_jwt" }, "linkExpired"],
    ["a rate limit", 429, {}, "rateLimited"],
    ["a provider failure", 500, {}, "service"],
  ] as const)("B31 a refusal for %s is shown as its sentence and stores nothing", async (_name, status, body, failure) => {
    provider(status, { ...body, msg: "PROVIDER-MSG-4b1d" });
    render(<ResetPasswordRoute />);
    setField(resetTestid.password, PASSWORD);
    setField(resetTestid.confirm, PASSWORD);
    submit();

    const error = await screen.findByTestId(resetTestid.error);
    expect(error.textContent).toBe(AUTH_MESSAGES[failure]);
    expect(document.body.textContent).not.toContain("PROVIDER-MSG-4b1d");
    expect(readSession()).toBeNull();
    expect(window.location.pathname).toBe(paths.resetPassword);
  });
});

// ---------------------------------------------------------------------------------------------
// B31: "the new password and reset-confirm, each with show and hide". The screen has one toggle,
// `reset-toggle-password`, and it must reveal the confirmation too, or the two can't be compared.
// ---------------------------------------------------------------------------------------------

describe("B31 show and hide", () => {
  beforeEach(() => {
    holdRecoverySession(RECOVERY, EMAIL);
  });

  it("B31 reset-toggle-password shows and hides reset-confirm together with the new password", () => {
    render(<ResetPasswordRoute />);
    const toggle = screen.getByTestId(resetTestid.togglePassword);
    const password = screen.getByTestId(resetTestid.password);
    const confirm = screen.getByTestId(resetTestid.confirm);

    fireEvent.click(toggle);
    expect(password).toHaveAttribute("type", "text");
    expect(confirm).toHaveAttribute("type", "text");
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(toggle);
    expect(password).toHaveAttribute("type", "password");
    expect(confirm).toHaveAttribute("type", "password");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  it("B31 showing the passwords keeps what was typed in both fields", () => {
    render(<ResetPasswordRoute />);
    setField(resetTestid.password, PASSWORD);
    setField(resetTestid.confirm, `${PASSWORD}z`);

    fireEvent.click(screen.getByTestId(resetTestid.togglePassword));

    expect(screen.getByTestId(resetTestid.password)).toHaveValue(PASSWORD);
    expect(screen.getByTestId(resetTestid.confirm)).toHaveValue(`${PASSWORD}z`);
  });
});

// ---------------------------------------------------------------------------------------------
// The adversarial panel's findings
// ---------------------------------------------------------------------------------------------

function unsignedJwt(payload: Record<string, unknown>): string {
  const part = (value: unknown): string =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${part({ alg: "HS256" })}.${part(payload)}.unsigned`;
}

describe("B31 the reset form and the browser", () => {
  beforeEach(() => {
    holdRecoverySession(RECOVERY, EMAIL);
  });

  it("B31 carries the account as a username, so a password manager saves the new password against it", () => {
    render(<ResetPasswordRoute />);
    const username = screen.getByTestId(resetTestid.form).querySelector('input[autocomplete="username"]');
    expect(username).not.toBeNull();
    expect((username as HTMLInputElement).value).toBe(EMAIL);
    expect((username as HTMLInputElement).readOnly).toBe(true);
  });

  it("B31 neither password is auto-capitalised, auto-corrected or spell-checked when shown", () => {
    render(<ResetPasswordRoute />);
    fireEvent.click(screen.getByTestId(resetTestid.togglePassword));
    for (const id of [resetTestid.password, resetTestid.confirm]) {
      const input = screen.getByTestId(id);
      expect(input, id).toHaveAttribute("type", "text");
      expect(input, id).toHaveAttribute("autocapitalize", "none");
      expect(input, id).toHaveAttribute("autocorrect", "off");
      expect(input, id).toHaveAttribute("spellcheck", "false");
    }
  });

  it("R193 says so when saving will replace the session of another account this browser holds", () => {
    window.localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ accessToken: unsignedJwt({ sub: "other", email: "other@example.com" }) }),
    );
    render(<ResetPasswordRoute />);
    expect(screen.getByTestId(resetTestid.replaces).textContent).toContain("other@example.com");
  });

  it("R193 says nothing of the kind when the browser holds this account, or none", () => {
    render(<ResetPasswordRoute />);
    expect(screen.queryByTestId(resetTestid.replaces)).toBeNull();
    cleanup();
    window.localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ accessToken: unsignedJwt({ sub: "same", email: EMAIL.toUpperCase() }) }),
    );
    render(<ResetPasswordRoute />);
    expect(screen.queryByTestId(resetTestid.replaces)).toBeNull();
  });

  it("R193 forgets the pending reset once the new password is saved", async () => {
    rememberPendingReset(EMAIL);
    provider(200, { id: "user-1", email: EMAIL });
    render(<ResetPasswordRoute />);
    setField(resetTestid.password, PASSWORD);
    setField(resetTestid.confirm, PASSWORD);
    submit();
    await waitFor(() => {
      expect(window.location.pathname).toBe(paths.decks);
    });
    expect(pendingReset()).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The second panel: a recovery session nobody can come back to, and one a reload does not spend
// ---------------------------------------------------------------------------------------------

/** Every call to the provider, with the bearer it carried. */
function recordProvider(status = 204): { url: string; bearer: string | null }[] {
  const calls: { url: string; bearer: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), bearer: new Headers(init?.headers).get("authorization") });
      return Promise.resolve(providerResponse(status, status === 204 ? undefined : {}));
    }),
  );
  return calls;
}

function revoked(calls: readonly { url: string; bearer: string | null }[], token: string): boolean {
  return calls.some((call) => call.url.includes("/auth/v1/logout") && call.bearer === `Bearer ${token}`);
}

describe("R193 leaving the reset screen lets go of the recovery session", () => {
  beforeEach(() => {
    holdRecoverySession(RECOVERY, EMAIL);
  });

  it.each([
    ["Back to sign in", resetTestid.backToSignIn, paths.login],
    ["the back link", navTestid.back, paths.landing],
  ] as const)("R193 leaving by %s asks first; confirmed, it forgets the session and revokes it at the provider", async (_name, testId, target) => {
    const calls = recordProvider();
    render(<ResetPasswordRoute />);
    fireEvent.click(screen.getByTestId(testId));

    // One stray tap spends nothing: the link works only once.
    expect(screen.getByTestId(resetTestid.leaveConfirm)).toBeInTheDocument();
    expect(recoverySession()).toEqual({ session: RECOVERY, email: EMAIL });
    expect(window.location.pathname).toBe(paths.resetPassword);
    await flushMicrotasks();
    expect(revoked(calls, RECOVERY.accessToken)).toBe(false);

    fireEvent.click(screen.getByTestId(resetTestid.leave));
    expect(window.location.pathname).toBe(target);
    expect(recoverySession()).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
    await waitFor(() => {
      expect(revoked(calls, RECOVERY.accessToken)).toBe(true);
    });
  });

  it("R193 'Stay' keeps the form and the session, and nothing is revoked", async () => {
    const calls = recordProvider();
    render(<ResetPasswordRoute />);
    setField(resetTestid.password, PASSWORD);
    fireEvent.click(screen.getByTestId(navTestid.back));
    fireEvent.click(screen.getByTestId(resetTestid.stay));

    expect(screen.queryByTestId(resetTestid.leaveConfirm)).toBeNull();
    expect(screen.getByTestId(resetTestid.form)).toBeInTheDocument();
    expect(screen.getByTestId(resetTestid.password)).toHaveValue(PASSWORD);
    expect(recoverySession()).toEqual({ session: RECOVERY, email: EMAIL });
    await flushMicrotasks();
    expect(revoked(calls, RECOVERY.accessToken)).toBe(false);
  });

  it("R193 once the provider has refused the link, leaving needs no confirmation: there is nothing left to lose", async () => {
    provider(401, { error_code: "bad_jwt" });
    holdRecoverySession({ ...RECOVERY, refreshToken: null }, EMAIL);
    render(<ResetPasswordRoute />);
    setField(resetTestid.password, PASSWORD);
    setField(resetTestid.confirm, PASSWORD);
    submit();
    expect((await screen.findByTestId(resetTestid.error)).textContent).toBe(AUTH_MESSAGES.linkExpired);
    fireEvent.click(screen.getByTestId(resetTestid.backToSignIn));
    expect(window.location.pathname).toBe(paths.login);
  });

  it("R193 the browser's Back button after leaving finds no working form (the shared-computer case)", async () => {
    recordProvider();
    const { App } = await import("../main.tsx");
    render(<App />);
    fireEvent.click(await screen.findByTestId(resetTestid.backToSignIn, undefined, { timeout: 5_000 }));
    fireEvent.click(screen.getByTestId(resetTestid.leave));
    await waitFor(() => {
      expect(window.location.pathname).toBe(paths.login);
    });

    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await waitFor(() => {
      expect(window.location.pathname).toBe(paths.resetPassword);
    });
    expect(await screen.findByTestId(resetTestid.noLink, undefined, { timeout: 5_000 })).toBeInTheDocument();
    expect(screen.queryByTestId(resetTestid.form)).toBeNull();
    expect(recoverySession()).toBeNull();
  });

  it("R193 moving away within the app any other way abandons it: forgotten, and revoked at the provider", async () => {
    const calls = recordProvider();
    render(<ResetPasswordRoute />);
    expect(recoverySession()).not.toBeNull();
    cleanup(); // what a move to another route (or the browser's Back within the app) does to it
    await waitFor(() => {
      expect(revoked(calls, RECOVERY.accessToken)).toBe(true);
    });
    expect(recoverySession()).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
  });

  it("R193 React's StrictMode rehearsal (unmount, mount again) neither forgets nor revokes it", async () => {
    const calls = recordProvider();
    render(
      <StrictMode>
        <ResetPasswordRoute />
      </StrictMode>,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByTestId(resetTestid.form)).toBeInTheDocument();
    expect(recoverySession()).toEqual({ session: RECOVERY, email: EMAIL });
    expect(revoked(calls, RECOVERY.accessToken)).toBe(false);
  });

  it("R193 leaving the page for another (into the back/forward cache) abandons it, and a restore shows no form", async () => {
    const calls = recordProvider();
    render(<ResetPasswordRoute />);
    act(() => {
      window.dispatchEvent(Object.assign(new Event("pagehide"), { persisted: true }));
    });
    expect(recoverySession()).toBeNull();
    await waitFor(() => {
      expect(revoked(calls, RECOVERY.accessToken)).toBe(true);
    });
    act(() => {
      window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    });
    expect(screen.getByTestId(resetTestid.noLink)).toBeInTheDocument();
    expect(screen.queryByTestId(resetTestid.form)).toBeNull();
  });

  it("R193 a reload keeps it: pagehide that is not into the cache lets nothing go", () => {
    render(<ResetPasswordRoute />);
    act(() => {
      window.dispatchEvent(Object.assign(new Event("pagehide"), { persisted: false }));
    });
    expect(recoverySession()).toEqual({ session: RECOVERY, email: EMAIL });
  });

  it("R193 a reload (a fresh module graph) still shows the form: the tab's storage kept the reset", async () => {
    vi.resetModules();
    const { default: Reloaded } = await import("./reset-password.tsx");
    render(<Reloaded />);
    expect(screen.getByTestId(resetTestid.form)).toBeInTheDocument();
    expect(screen.getByTestId(resetTestid.email).textContent).toBe(EMAIL);
  });

  it("R193 a page the Back or Forward button loads afresh finds the reset abandoned", async () => {
    const calls = recordProvider();
    const entries = vi
      .spyOn(performance, "getEntriesByType")
      .mockReturnValue([{ type: "back_forward" } as unknown as PerformanceEntry]);
    try {
      render(<ResetPasswordRoute />);
      expect(screen.getByTestId(resetTestid.noLink)).toBeInTheDocument();
      expect(recoverySession()).toBeNull();
      await waitFor(() => {
        expect(revoked(calls, RECOVERY.accessToken)).toBe(true);
      });
    } finally {
      entries.mockRestore();
    }
  });
});

describe("R194 saving revokes the session the reset replaces", () => {
  it("R194 'Saving signs this browser out of A' revokes A at the provider", async () => {
    const aAccess = unsignedJwt({ sub: "a", email: "a@example.com" });
    window.localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ accessToken: aAccess, refreshToken: "a-refresh", expiresAt: RECOVERY.expiresAt }),
    );
    holdRecoverySession(RECOVERY, "b@example.com");
    const calls = recordProvider(200);
    render(<ResetPasswordRoute />);
    expect(screen.getByTestId(resetTestid.replaces).textContent).toContain("a@example.com");

    setField(resetTestid.password, PASSWORD);
    setField(resetTestid.confirm, PASSWORD);
    submit();
    await waitFor(() => {
      expect(window.location.pathname).toBe(paths.decks);
    });
    expect(readSession()?.accessToken).toBe(RECOVERY.accessToken);
    await waitFor(() => {
      expect(revoked(calls, aAccess)).toBe(true);
    });
    // The new session itself is never revoked.
    expect(revoked(calls, RECOVERY.accessToken)).toBe(false);
  });
});

describe("B31 a password past the provider's byte limit", () => {
  beforeEach(() => {
    holdRecoverySession(RECOVERY, EMAIL);
  });

  it("B31 40 Cyrillic letters (80 bytes) are refused before sending, in words that promise no character count", () => {
    const calls = provider(200, {});
    render(<ResetPasswordRoute />);
    const long = "ж".repeat(40);
    setField(resetTestid.password, long);
    setField(resetTestid.confirm, long);
    submit();
    expect(screen.getByTestId(resetTestid.passwordError).textContent).toMatch(/too long/);
    expect(screen.getByTestId(resetTestid.passwordError).textContent).not.toMatch(/characters\./);
    expect(calls).toHaveLength(0);
  });

  it("B31 the provider's validation_failed reads as a password that is too long, not a service fault", async () => {
    provider(400, { code: 400, error_code: "validation_failed", msg: "Password cannot be longer than 72 characters" });
    render(<ResetPasswordRoute />);
    setField(resetTestid.password, PASSWORD);
    setField(resetTestid.confirm, PASSWORD);
    submit();
    const error = await screen.findByTestId(resetTestid.error);
    expect(error.textContent).toBe(AUTH_MESSAGES.passwordTooLong);
    expect(error.textContent).not.toBe(AUTH_MESSAGES.service);
  });
});


// ---------------------------------------------------------------------------------------------
// R194: a recovery session that runs out while the form is open is renewed, not called spent
// ---------------------------------------------------------------------------------------------

describe("R194 a recovery session that runs out while the form is open", () => {
  /** The provider: PUT /user refuses `expiredToken` as a spent JWT; the refresh grant answers `refresh`. */
  function renewingProvider(
    expiredToken: string,
    refresh: { status: number; body: unknown },
  ): { bearers: string[]; refreshes: unknown[] } {
    const bearers: string[] = [];
    const refreshes: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/auth/v1/user")) {
          const bearer = new Headers(init?.headers).get("authorization") ?? "";
          bearers.push(bearer);
          return Promise.resolve(
            bearer === `Bearer ${expiredToken}`
              ? providerResponse(401, { code: 401, error_code: "bad_jwt", msg: "token is expired" })
              : providerResponse(200, { id: "user-1" }),
          );
        }
        if (url.includes("grant_type=refresh_token")) {
          refreshes.push(typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
          return Promise.resolve(providerResponse(refresh.status, refresh.body));
        }
        return Promise.resolve(providerResponse(204));
      }),
    );
    return { bearers, refreshes };
  }

  const RENEWED = {
    status: 200,
    body: { access_token: "recovery-access-2", refresh_token: "recovery-refresh-2", expires_in: 3600, token_type: "bearer" },
  };

  it("R194 is renewed with its refresh token before the password is sent, and the renewal is saved", async () => {
    holdRecoverySession({ accessToken: "recovery-access-1", refreshToken: "recovery-refresh-1", expiresAt: Date.now() + 30 }, EMAIL);
    const { bearers, refreshes } = renewingProvider("recovery-access-1", RENEWED);
    render(<ResetPasswordRoute />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60)); // the access token has now expired
    });

    setField(resetTestid.password, PASSWORD);
    setField(resetTestid.confirm, PASSWORD);
    submit();
    await waitFor(() => {
      expect(window.location.pathname).toBe(paths.decks);
    });
    expect(refreshes).toEqual([{ refresh_token: "recovery-refresh-1" }]);
    expect(bearers).toEqual(["Bearer recovery-access-2"]);
    expect(readSession()?.accessToken).toBe("recovery-access-2");
    expect(screen.queryByTestId(resetTestid.error)).toBeNull();
  });

  it("R194 one already past its expiry when the screen opens is shown and renewed, not dropped as no link", async () => {
    // A device whose clock runs fast, or a player who came back to the tab: the access token looks
    // expired, but the refresh token still renews it, and the one-time link must not be lost.
    holdRecoverySession({ accessToken: "recovery-access-1", refreshToken: "recovery-refresh-1", expiresAt: Date.now() - 60_000 }, EMAIL);
    const { bearers, refreshes } = renewingProvider("recovery-access-1", RENEWED);
    render(<ResetPasswordRoute />);
    expect(screen.queryByTestId(resetTestid.noLink)).toBeNull();
    expect(screen.getByTestId(resetTestid.form)).toBeInTheDocument();

    setField(resetTestid.password, PASSWORD);
    setField(resetTestid.confirm, PASSWORD);
    submit();
    await waitFor(() => {
      expect(window.location.pathname).toBe(paths.decks);
    });
    expect(refreshes).toEqual([{ refresh_token: "recovery-refresh-1" }]);
    expect(bearers).toEqual(["Bearer recovery-access-2"]);
  });

  it("R194 an access token the provider refuses while it still looked live is renewed once and the password sent again", async () => {
    holdRecoverySession({ accessToken: "recovery-access-1", refreshToken: "recovery-refresh-1", expiresAt: RECOVERY.expiresAt }, EMAIL);
    const { bearers, refreshes } = renewingProvider("recovery-access-1", RENEWED);
    render(<ResetPasswordRoute />);
    setField(resetTestid.password, PASSWORD);
    setField(resetTestid.confirm, PASSWORD);
    submit();
    await waitFor(() => {
      expect(window.location.pathname).toBe(paths.decks);
    });
    expect(bearers).toEqual(["Bearer recovery-access-1", "Bearer recovery-access-2"]);
    expect(refreshes).toHaveLength(1);
    expect(readSession()?.accessToken).toBe("recovery-access-2");
  });

  it("R194 a renewal the provider refuses is the spent link it then is, with the way to a new one", async () => {
    holdRecoverySession({ accessToken: "recovery-access-1", refreshToken: "recovery-refresh-1", expiresAt: RECOVERY.expiresAt }, EMAIL);
    renewingProvider("recovery-access-1", { status: 400, body: { error_code: "refresh_token_already_used" } });
    render(<ResetPasswordRoute />);
    setField(resetTestid.password, PASSWORD);
    setField(resetTestid.confirm, PASSWORD);
    submit();
    expect((await screen.findByTestId(resetTestid.error)).textContent).toBe(AUTH_MESSAGES.linkExpired);
    expect(screen.getByTestId(resetTestid.requestNew)).toBeInTheDocument();
    expect(window.location.pathname).toBe(paths.resetPassword);
    expect(readSession()).toBeNull();
  });

  it("R194 a renewal that cannot reach the provider keeps the session and says so", async () => {
    holdRecoverySession({ accessToken: "recovery-access-1", refreshToken: "recovery-refresh-1", expiresAt: Date.now() + 30 }, EMAIL);
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    render(<ResetPasswordRoute />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    setField(resetTestid.password, PASSWORD);
    setField(resetTestid.confirm, PASSWORD);
    submit();
    expect((await screen.findByTestId(resetTestid.error)).textContent).toBe(AUTH_MESSAGES.network);
    expect(screen.queryByTestId(resetTestid.requestNew)).toBeNull();
  });
});
