// Emailed auth links (docs/polish/5-sign-in.md, B29, B30, R193; PKCE codes, R323, R324).
//
// `parseAuthRedirect` is pure over a URL; `consumeAuthRedirect` reads jsdom's location once, scrubs
// the address bar when any auth parameter is present, and caches its answer until cleared. A
// recovery session is held for this tab only: memory and `sessionStorage`, never `localStorage`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RECOVERY_STORAGE_KEY,
  abandonRecoverySession,
  adoptAuthRedirect,
  clearConsumedAuthRedirect,
  consumeAuthRedirect,
  emailFromToken,
  holdRecoverySession,
  parseAuthRedirect,
  recoverySession,
  releaseRecoverySession,
  subjectFromToken,
} from "./redirect.ts";

const ORIGIN = "https://jackioh.example";
const EMAIL = "player@example.com";
const EXPIRES_AT_S = 2_000_000_000;
const REFRESH = "refresh-from-link";

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

const TOKEN = jwt({ sub: "user-1", email: EMAIL });

function params(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

/**
 * A link's parameters. `expires_in` is left out so the expiry is the fixed `expires_at` and the
 * rows below compare whole sessions; the two tests on expiry put it back.
 */
function tokenParams(type: string | null, token = TOKEN): Record<string, string> {
  const values: Record<string, string> = {
    access_token: token,
    refresh_token: REFRESH,
    expires_at: String(EXPIRES_AT_S),
    token_type: "bearer",
  };
  if (type !== null) values.type = type;
  return values;
}

function fragmentUrl(values: Record<string, string>): URL {
  return new URL(`${ORIGIN}/login#${params(values)}`);
}

const SESSION = { accessToken: TOKEN, refreshToken: REFRESH, expiresAt: EXPIRES_AT_S * 1000 };

beforeEach(() => {
  clearConsumedAuthRedirect();
  releaseRecoverySession();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/login");
});

afterEach(() => {
  vi.useRealTimers();
  clearConsumedAuthRedirect();
  releaseRecoverySession();
});

// ---------------------------------------------------------------------------------------------
// parseAuthRedirect
// ---------------------------------------------------------------------------------------------

describe("R193 parseAuthRedirect", () => {
  it("R193 a URL with no auth parameters is none", () => {
    expect(parseAuthRedirect(new URL(`${ORIGIN}/login`))).toEqual({ kind: "none" });
    expect(parseAuthRedirect(new URL(`${ORIGIN}/login?mode=forgot#section`))).toEqual({ kind: "none" });
  });

  it.each([["signup"], ["invite"], ["magiclink"], ["email_change"]] as const)(
    "R193 B29 a type=%s link is a session, with the token's email",
    (type) => {
      expect(parseAuthRedirect(fragmentUrl(tokenParams(type)))).toEqual({
        kind: "session",
        session: SESSION,
        email: EMAIL,
        linkType: type,
      });
    },
  );

  it("R193 B30 a type=recovery link is a recovery", () => {
    expect(parseAuthRedirect(fragmentUrl(tokenParams("recovery")))).toEqual({
      kind: "recovery",
      session: SESSION,
      email: EMAIL,
    });
  });

  it("R193 without expires_in, expires_at is read as seconds", () => {
    const redirect = parseAuthRedirect(fragmentUrl(tokenParams("signup")));
    expect(redirect.kind === "session" ? redirect.session.expiresAt : null).toBe(EXPIRES_AT_S * 1000);
  });

  it("R193 R194 expires_in wins over expires_at: the expiry is counted on this device's clock", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // The provider's clock says 12:00; this device's runs 90 minutes fast.
    const providerNow = Date.UTC(2026, 8, 22, 12, 0, 0);
    const deviceNow = providerNow + 90 * 60_000;
    vi.setSystemTime(deviceNow);
    const values = tokenParams("recovery");
    values.expires_at = String(Math.floor(providerNow / 1000) + 3600);
    values.expires_in = "3600";
    const redirect = parseAuthRedirect(fragmentUrl(values));
    expect(redirect.kind).toBe("recovery");
    // Read from expires_at, a session the provider issued a moment ago looked 30 minutes dead.
    expect(redirect.kind === "recovery" ? redirect.session.expiresAt : null).toBe(deviceNow + 3600 * 1000);
  });

  it("R193 the email is read from a base64url payload, - and _ included", () => {
    // Find a payload whose plain base64 needs both '+' and '/', so base64url really differs.
    let payload: Record<string, unknown> | null = null;
    for (let shift = 0; shift < 3 && payload === null; shift += 1) {
      const candidate = { sub: "user-1", email: EMAIL, pad: `${" ".repeat(shift)}???>>>???>>>` };
      const plain = btoa(JSON.stringify(candidate));
      if (plain.includes("+") && plain.includes("/")) payload = candidate;
    }
    expect(payload, "premise: a payload that exercises base64url").not.toBeNull();
    const token = jwt(payload ?? {});
    expect(token).toMatch(/[-_]/);

    const redirect = parseAuthRedirect(fragmentUrl(tokenParams("signup", token)));
    expect(redirect).toEqual({
      kind: "session",
      session: { ...SESSION, accessToken: token },
      email: EMAIL,
      linkType: "signup",
    });
  });

  it.each([
    ["a payload with no email", jwt({ sub: "user-1" })],
    ["a numeric email claim", jwt({ sub: "user-1", email: 42 })],
    ["a token that is not a JWT", "opaque-access-token"],
    ["a payload that is not JSON", `${base64url("{}")}.${base64url("not json")}.unsigned`],
  ] as const)("R193 %s gives a session with a null email", (_name, token) => {
    const redirect = parseAuthRedirect(fragmentUrl(tokenParams("signup", token)));
    expect(redirect.kind).toBe("session");
    expect(redirect.kind === "session" ? redirect.email : undefined).toBeNull();
    expect(redirect.kind === "session" ? redirect.session.accessToken : undefined).toBe(token);
  });

  it("R193 tokens without a type are none", () => {
    expect(parseAuthRedirect(fragmentUrl(tokenParams(null)))).toEqual({ kind: "none" });
  });

  it.each([["phone_change"], ["admin"], [""]] as const)("R193 an unknown type %j is none", (type) => {
    expect(parseAuthRedirect(fragmentUrl(tokenParams(type)))).toEqual({ kind: "none" });
  });

  it("R193 B30 error_code=otp_expired in the fragment is linkExpired", () => {
    const url = new URL(
      `${ORIGIN}/login#${params({ error: "access_denied", error_code: "otp_expired", error_description: "x" })}`,
    );
    expect(parseAuthRedirect(url)).toEqual({ kind: "error", failure: "linkExpired" });
  });

  it("R193 B30 error_code=otp_expired in the query is linkExpired", () => {
    const url = new URL(
      `${ORIGIN}/login?${params({ error: "access_denied", error_code: "otp_expired", error_description: "x" })}`,
    );
    expect(parseAuthRedirect(url)).toEqual({ kind: "error", failure: "linkExpired" });
  });

  it.each([
    ["another error_code", { error: "access_denied", error_code: "bad_code_verifier" }],
    ["an error with no code", { error: "server_error" }],
    ["an error_code with no error", { error_code: "flow_state_not_found" }],
  ] as const)("R193 B30 %s is linkDenied", (_name, values) => {
    expect(parseAuthRedirect(fragmentUrl({ ...values }))).toEqual({ kind: "error", failure: "linkDenied" });
  });

  it("R193 error_description is never read into the result", () => {
    const result = parseAuthRedirect(
      fragmentUrl({ error: "access_denied", error_code: "otp_expired", error_description: "<b>provider</b>" }),
    );
    expect(JSON.stringify(result)).not.toContain("provider");
  });
});

// ---------------------------------------------------------------------------------------------
// consumeAuthRedirect
// ---------------------------------------------------------------------------------------------

describe("R193 a link's address is a claim", () => {
  it("R193 the email and the user id are read from a payload nobody has verified", () => {
    // Anyone can write this token: the reading is a claim for the server to check, not a fact.
    const forged = jwt({ sub: "whoever", email: "victim@example.com" });
    expect(emailFromToken(forged)).toBe("victim@example.com");
    expect(subjectFromToken(forged)).toBe("whoever");
    expect(subjectFromToken("not-a-jwt")).toBeNull();
    expect(emailFromToken(jwt({ sub: 7 }))).toBeNull();
  });
});

describe("R193 adoptAuthRedirect", () => {
  it("R193 scrubs a link on /login itself at boot, before the lazily loaded screen runs", () => {
    window.history.replaceState(null, "", `/login#${params(tokenParams("signup"))}`);
    expect(adoptAuthRedirect("/login")).toBe(false);
    expect(window.location.pathname).toBe("/login");
    expect(window.location.href).not.toContain("access_token");
    expect(window.location.href).not.toContain(REFRESH);
    // The screen, once loaded, reads the cached link.
    expect(consumeAuthRedirect()).toEqual({ kind: "session", session: SESSION, email: EMAIL, linkType: "signup" });
  });

  it("R193 moves a link on any other path to /login, scrubbed", () => {
    window.history.replaceState(null, "", `/#${params(tokenParams("recovery"))}`);
    expect(adoptAuthRedirect("/login")).toBe(true);
    expect(window.location.pathname).toBe("/login");
    expect(window.location.href).not.toContain(REFRESH);
    expect(consumeAuthRedirect().kind).toBe("recovery");
  });

  it("R193 leaves a URL with no auth parameter alone", () => {
    window.history.replaceState(null, "", "/login?mode=forgot");
    expect(adoptAuthRedirect("/login")).toBe(false);
    expect(window.location.search).toBe("?mode=forgot");
  });
});

describe("R193 consumeAuthRedirect", () => {
  it("R193 B29 reads the link and drops the fragment from the address bar", () => {
    window.history.replaceState(null, "", `/login#${params(tokenParams("signup"))}`);
    const first = consumeAuthRedirect();

    expect(first).toEqual({ kind: "session", session: SESSION, email: EMAIL, linkType: "signup" });
    expect(window.location.pathname).toBe("/login");
    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("");
    expect(window.location.href).not.toContain(TOKEN);
    expect(window.location.href).not.toContain("access_token");
  });

  it("R193 B30 an error in the query is scrubbed too", () => {
    window.history.replaceState(
      null,
      "",
      `/login?${params({ error: "access_denied", error_code: "otp_expired", error_description: "gone" })}`,
    );
    expect(consumeAuthRedirect()).toEqual({ kind: "error", failure: "linkExpired" });
    expect(window.location.search).toBe("");
    expect(window.location.href).not.toContain("otp_expired");
  });

  it("R193 a lone recognised parameter is scrubbed even when it forms no redirect", () => {
    window.history.replaceState(null, "", `/login#${params({ error_description: "stray" })}`);
    expect(consumeAuthRedirect()).toEqual({ kind: "none" });
    expect(window.location.hash).toBe("");
  });

  it("R193 a URL with no auth parameter is left as it is", () => {
    window.history.replaceState(null, "", "/login?mode=forgot");
    expect(consumeAuthRedirect()).toEqual({ kind: "none" });
    expect(window.location.search).toBe("?mode=forgot");
  });

  it("R193 a second call returns the same answer (StrictMode) until cleared", () => {
    window.history.replaceState(null, "", `/login#${params(tokenParams("signup"))}`);
    const first = consumeAuthRedirect();
    const second = consumeAuthRedirect();
    expect(second).toEqual(first);
    expect(second.kind).toBe("session");

    clearConsumedAuthRedirect();
    expect(consumeAuthRedirect()).toEqual({ kind: "none" });
  });

  it("R193 consuming writes nothing to storage", () => {
    window.history.replaceState(null, "", `/login#${params(tokenParams("recovery"))}`);
    consumeAuthRedirect();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// the recovery session: memory only
// ---------------------------------------------------------------------------------------------

describe("R193 B30 the recovery session", () => {
  it("R193 is held for this tab only: memory and sessionStorage, never localStorage", () => {
    expect(recoverySession()).toBeNull();
    holdRecoverySession(SESSION, EMAIL);
    expect(recoverySession()).toEqual({ session: SESSION, email: EMAIL });
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.getItem(RECOVERY_STORAGE_KEY)).not.toBeNull();

    releaseRecoverySession();
    expect(recoverySession()).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
  });

  it("R193 survives a reload: a fresh module graph finds it in the tab's storage", async () => {
    holdRecoverySession(SESSION, EMAIL);
    vi.resetModules();
    const reloaded = await import("./redirect.ts");
    expect(reloaded.recoverySession()).toEqual({ session: SESSION, email: EMAIL });
    reloaded.releaseRecoverySession();
  });

  it("R193 one whose access token has expired, with no refresh token to renew it, is dropped", () => {
    holdRecoverySession({ ...SESSION, refreshToken: null, expiresAt: Date.now() - 1 }, EMAIL);
    expect(recoverySession()).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
  });

  it("R193 R194 one whose access token has expired is kept while it can be renewed: the reset screen renews it", () => {
    const expired = { ...SESSION, expiresAt: Date.now() - 1 };
    holdRecoverySession(expired, EMAIL);
    expect(recoverySession()).toEqual({ session: expired, email: EMAIL });
  });

  it("R193 a mirror that is not a held session is nothing", () => {
    window.sessionStorage.setItem(RECOVERY_STORAGE_KEY, "{not json");
    expect(recoverySession()).toBeNull();
    window.sessionStorage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify({ session: { accessToken: "" } }));
    expect(recoverySession()).toBeNull();
  });

  it("R193 abandoning it forgets it and revokes it at the provider", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetch);
    try {
      holdRecoverySession(SESSION, EMAIL);
      abandonRecoverySession();
      expect(recoverySession()).toBeNull();
      expect(window.sessionStorage.length).toBe(0);
      await vi.waitFor(() => {
        expect(fetch).toHaveBeenCalled();
      });
      const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toContain("/auth/v1/logout");
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("R193 R194 abandoning one whose access token has expired renews it first, then revokes the renewal", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    const calls: Array<[string, string, string | null]> = [];
    const fetch = vi.fn((input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      const bearer = new Headers(init?.headers).get("authorization");
      calls.push([init?.method ?? "GET", `${url.pathname}${url.search}`, bearer]);
      if (url.searchParams.get("grant_type") === "refresh_token") {
        return Promise.resolve(
          new Response(
            JSON.stringify({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      // The provider refuses to revoke with an expired access token.
      return Promise.resolve(new Response(null, { status: bearer === "Bearer expired-access" ? 401 : 204 }));
    });
    vi.stubGlobal("fetch", fetch);
    try {
      // The reset form was left open past the hour: the link's session is kept, since it can renew.
      holdRecoverySession(
        { accessToken: "expired-access", refreshToken: "link-refresh-token-from-the-url", expiresAt: Date.now() - 60_000 },
        EMAIL,
      );
      abandonRecoverySession();
      expect(recoverySession()).toBeNull();
      await vi.waitFor(() => {
        expect(calls.some(([, path]) => path.startsWith("/auth/v1/logout"))).toBe(true);
      });
      expect(calls).toEqual([
        ["POST", "/auth/v1/token?grant_type=refresh_token", "Bearer sb_publishable_test"],
        ["POST", "/auth/v1/logout?scope=local", "Bearer fresh-access"],
      ]);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("R193 may be held without an address", () => {
    holdRecoverySession(SESSION, null);
    expect(recoverySession()).toEqual({ session: SESSION, email: null });
  });
});

describe("R323 R324 a PKCE link's code", () => {
  const CODE = "3f9c6c1e-5a6b-4c2d-9e8f-0a1b2c3d4e5f";

  it("R323 a code in the query on /login or / is a code, never a session", () => {
    for (const path of ["/login", "/"]) {
      expect(parseAuthRedirect(new URL(`${ORIGIN}${path}?code=${CODE}`)), path).toEqual({ kind: "code", code: CODE });
    }
  });

  it("R323 a code on any other page is that page's, and is neither read nor scrubbed", () => {
    expect(parseAuthRedirect(new URL(`${ORIGIN}/practice?code=${CODE}`))).toEqual({ kind: "none" });
    window.history.replaceState(null, "", `/practice?code=${CODE}`);
    expect(consumeAuthRedirect()).toEqual({ kind: "none" });
    expect(adoptAuthRedirect("/login")).toBe(false);
    expect(window.location.search).toBe(`?code=${CODE}`);
  });

  it("R323 an error beside a code outranks it, and a code that is not an auth code's shape is no link", () => {
    expect(parseAuthRedirect(new URL(`${ORIGIN}/login?code=${CODE}&error=access_denied&error_code=otp_expired`))).toEqual({
      kind: "error",
      failure: "linkExpired",
    });
    for (const code of ["", "<script>", "a".repeat(200), "code with spaces"]) {
      expect(parseAuthRedirect(new URL(`${ORIGIN}/login?${params({ code })}`)), code).toEqual({ kind: "none" });
    }
  });

  it("R323 consumeAuthRedirect reads the code and drops it from the address bar", () => {
    window.history.replaceState(null, "", `/login?code=${CODE}`);
    expect(consumeAuthRedirect()).toEqual({ kind: "code", code: CODE });
    expect(window.location.pathname).toBe("/login");
    expect(window.location.search).toBe("");
    expect(window.location.href).not.toContain(CODE);
  });

  it("R323 a code that landed on the Site URL is moved to /login, scrubbed", () => {
    window.history.replaceState(null, "", `/?code=${CODE}`);
    expect(adoptAuthRedirect("/login")).toBe(true);
    expect(window.location.pathname).toBe("/login");
    expect(window.location.search).toBe("");
    expect(consumeAuthRedirect()).toEqual({ kind: "code", code: CODE });
  });

  it("R324 an implicit-flow link, tokens in the fragment, is still read as before", () => {
    expect(parseAuthRedirect(new URL(`${ORIGIN}/login#${params(tokenParams("signup"))}`))).toMatchObject({
      kind: "session",
      linkType: "signup",
      email: EMAIL,
    });
    expect(parseAuthRedirect(new URL(`${ORIGIN}/login#${params(tokenParams("recovery"))}`))).toMatchObject({
      kind: "recovery",
      email: EMAIL,
    });
  });
});
